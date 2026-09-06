"""VLM loader for VQA and captioning using Qwen2-VL.

Model choice: Qwen/Qwen2-VL-2B-Instruct (~4GB)
  - Modern vision-language model with LLM decoder (Qwen2-2B)
  - Supports both VQA and captioning via instruction following
  - Proper supervised fine-tuning support with labels
  - LoRA-friendly (target language model decoder layers)
  - Dataset cpratikaki/RSVQA-HR_qwen_finetuning is pre-formatted for Qwen

Output formats:
  - VQA:        lowercase short word/phrase (matches RSVQA benchmark)
  - Captioning: natural English sentence (matches VRSBench)

LoRA fine-tuning for Section 12.3 targets the Qwen2 language model
decoder layers (self-attention q_proj and v_proj).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from PIL import Image

logger = logging.getLogger(__name__)

_MODEL_CACHE: dict[str, Any] = {}

# Centralized VLM configuration. Real inference uses one Qwen2-VL model by
# default; individual tools can be pointed at different model IDs via
# VQA_MODEL / CAPTION_MODEL without changing code.
DEFAULT_MODEL = os.environ.get("VLM_MODEL", "Qwen/Qwen2-VL-2B-Instruct")
DEFAULT_VQA_MODEL = os.environ.get("VQA_MODEL", DEFAULT_MODEL)
DEFAULT_CAPTION_MODEL = os.environ.get("CAPTION_MODEL", DEFAULT_MODEL)


class VLMUnavailableError(RuntimeError):
    """Real VLM inference is unavailable (dependencies or model weights missing).

    API endpoints translate this into a clearly-labeled offline placeholder so
    the service stays bootable — and honest — when PyTorch / model weights are
    not installed. It must never be treated as a real model result.
    """


def _import_torch():
    try:
        import torch
        return torch
    except ImportError as exc:
        raise VLMUnavailableError(
            "Real VLM inference unavailable: PyTorch is not installed."
        ) from exc


def _import_vision_utils():
    try:
        from qwen_vl_utils import process_vision_info
        return process_vision_info
    except ImportError as exc:
        raise VLMUnavailableError(
            "Real VLM inference unavailable: qwen-vl-utils is not installed."
        ) from exc


def _device() -> Any:
    torch = _import_torch()
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _dtype_for(device: Any) -> Any:
    torch = _import_torch()
    return torch.bfloat16 if device.type == "cuda" else torch.float32


def load_qwen_model(model_name: str = DEFAULT_MODEL, adapter_path: str | None = None) -> tuple[Any, Any]:
    """Load (and cache) the Qwen2-VL model + processor.

    Returns (model, processor) tuple. If adapter_path is provided,
    loads LoRA weights on top of the base model.

    Raises:
        VLMUnavailableError: when PyTorch/transformers/peft or the model weights
            are unavailable, so callers can fall back to a labeled offline path.
    """
    cache_key = f"qwen:{model_name}:{adapter_path or 'base'}"
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]

    _import_torch()
    try:
        from transformers import Qwen2VLForConditionalGeneration, AutoProcessor
    except ImportError as exc:
        raise VLMUnavailableError(
            "Real VLM inference unavailable: transformers is not installed."
        ) from exc

    try:
        logger.info("Loading Qwen2-VL model: %s", model_name)
        device = _device()
        dtype = _dtype_for(device)

        processor = AutoProcessor.from_pretrained(model_name)
        model = Qwen2VLForConditionalGeneration.from_pretrained(
            model_name,
            torch_dtype=dtype,
            device_map="auto" if device.type == "cuda" else None,
        )
    except VLMUnavailableError:
        raise
    except Exception as exc:
        raise VLMUnavailableError(
            f"Real VLM inference unavailable: could not load model/weights for '{model_name}': {exc}"
        ) from exc

    if adapter_path and Path(adapter_path).exists():
        logger.info("Applying LoRA adapter from: %s", adapter_path)
        try:
            from peft import PeftModel
            model = PeftModel.from_pretrained(model, adapter_path)
        except ImportError as exc:
            raise VLMUnavailableError(
                "Real VLM inference unavailable: peft is required to load a LoRA adapter but is not installed."
            ) from exc
        except Exception as exc:
            raise VLMUnavailableError(
                f"Real VLM inference unavailable: failed to apply LoRA adapter '{adapter_path}': {exc}"
            ) from exc

    if device.type == "cpu":
        model.to(device)

    model.eval()
    _MODEL_CACHE[cache_key] = (model, processor)
    logger.info("Qwen2-VL model ready on %s (dtype=%s)", device, dtype)
    return model, processor


def run_vqa(
    image: Image.Image,
    question: str,
    model_name: str = DEFAULT_VQA_MODEL,
    adapter_path: str | None = None,
) -> tuple[str, float]:
    """Run VQA inference using Qwen2-VL.

    Returns (answer, confidence) tuple. Answer is lowercase, trimmed,
    matching RSVQA expected format (single word or short phrase like
    "yes", "no", "3", "farmland").

    Raises:
        VLMUnavailableError: when PyTorch / model weights are unavailable.
    """
    process_vision_info = _import_vision_utils()
    torch = _import_torch()
    model, processor = load_qwen_model(model_name, adapter_path)
    device = next(model.parameters()).device

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": question},
            ],
        }
    ]

    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    image_inputs, video_inputs = process_vision_info(messages)
    
    inputs = processor(
        text=[text],
        images=image_inputs,
        videos=video_inputs,
        padding=True,
        return_tensors="pt",
    ).to(device)

    with torch.no_grad():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=20,
            do_sample=False,
        )

    output_ids = output_ids[:, inputs.input_ids.shape[1]:]
    answer = processor.batch_decode(output_ids, skip_special_tokens=True)[0].strip().lower()

    confidence = _vqa_confidence(answer)
    return answer, confidence


def run_caption(
    image: Image.Image,
    model_name: str = DEFAULT_CAPTION_MODEL,
    adapter_path: str | None = None,
) -> tuple[str, float]:
    """Run image captioning inference using Qwen2-VL.

    Returns (caption, confidence) tuple. Caption is a natural English
    sentence as required by VRSBench BLEU/CIDEr evaluation.

    Raises:
        VLMUnavailableError: when PyTorch / model weights are unavailable.
    """
    process_vision_info = _import_vision_utils()
    torch = _import_torch()
    model, processor = load_qwen_model(model_name, adapter_path)
    device = next(model.parameters()).device

    prompt = "Describe this satellite image in one sentence."
    
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": prompt},
            ],
        }
    ]

    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    image_inputs, video_inputs = process_vision_info(messages)
    
    inputs = processor(
        text=[text],
        images=image_inputs,
        videos=video_inputs,
        padding=True,
        return_tensors="pt",
    ).to(device)

    with torch.no_grad():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=60,
            do_sample=False,
        )

    output_ids = output_ids[:, inputs.input_ids.shape[1]:]
    caption = processor.batch_decode(output_ids, skip_special_tokens=True)[0].strip()

    if caption and not caption[0].isupper():
        caption = caption.capitalize()

    confidence = _caption_confidence(caption)
    return caption, confidence


def _vqa_confidence(answer: str) -> float:
    """Confidence heuristic for VQA answers.
    
    Conservative proxy based on answer structure:
      - Empty: 0.0
      - Binary yes/no: 0.80
      - Other: 0.70
    """
    if not answer:
        return 0.0
    if answer in {"yes", "no"}:
        return 0.80
    return 0.70


def _caption_confidence(caption: str) -> float:
    """Confidence heuristic for captions.
    
    Proxy based on caption length: very short outputs (<5 words)
    suggest incomplete generation.
    """
    words = caption.split()
    if len(words) < 5:
        return 0.50
    return 0.75
