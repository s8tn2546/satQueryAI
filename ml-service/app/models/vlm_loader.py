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
import threading
from pathlib import Path
from typing import Any

from PIL import Image

logger = logging.getLogger(__name__)

_MODEL_CACHE: dict[str, tuple[Any, Any]] = {}
# Single-flight lock so concurrent first requests (or warmup racing a request)
# load ONE model instance instead of N duplicate 4GB copies.
_MODEL_LOAD_LOCK = threading.Lock()
# Inference serialization lock. HF transformers processors/model.generate are
# not documented as thread-safe on a shared instance, and the service runs a
# single worker thread per inference already. One global lock keeps behaviour
# deterministic, prevents corrupt state under concurrency and avoids OpenMP
# oversubscription when two generations would otherwise fight for CPU cores.
_INFERENCE_LOCK = threading.Lock()

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
    if torch.cuda.is_available():
        return torch.device("cuda")
    # Apple Silicon Metal backend, used only when actually available. Measured
    # ~3-5x faster than CPU on this stack (M2, Qwen2-VL-2B) with identical
    # greedy output; falls back to CPU otherwise. Never hardcodes a device.
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def _dtype_for(device: Any) -> Any:
    torch = _import_torch()
    if device.type == "cuda":
        return torch.bfloat16
    if device.type == "mps":
        return torch.float16
    return torch.float32


def _build_qwen_model(model_name: str, adapter_path: str | None) -> tuple[Any, Any]:
    """Load a fresh Qwen2-VL model + processor from weights (no caching)."""
    _import_torch()
    try:
        from transformers import Qwen2VLForConditionalGeneration, AutoProcessor
    except ImportError as exc:
        raise VLMUnavailableError(
            "Real VLM inference unavailable: transformers is not installed."
        ) from exc

    device = _device()
    dtype = _dtype_for(device)

    try:
        logger.info("Loading Qwen2-VL model: %s", model_name)
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
    elif adapter_path:
        logger.warning(
            "LoRA adapter path configured but not found on disk; running base "
            "model without adapter: %s",
            adapter_path,
        )

    if device.type in ("cpu", "mps"):
        model.to(device)

    model.eval()
    logger.info("Qwen2-VL model ready on %s (dtype=%s)", device, dtype)
    return model, processor


def load_qwen_model(model_name: str = DEFAULT_MODEL, adapter_path: str | None = None) -> tuple[Any, Any]:
    """Load (and cache) the Qwen2-VL model + processor.

    Returns (model, processor) tuple. If adapter_path is provided,
    loads LoRA weights on top of the base model.

    Single-flight: concurrent callers for the same cache key share one load,
    so warmup or two concurrent requests can never build duplicate model
    instances.

    Raises:
        VLMUnavailableError: when PyTorch/transformers/peft or the model weights
            are unavailable, so callers can fall back to a labeled offline path.
    """
    cache_key = f"qwen:{model_name}:{adapter_path or 'base'}"
    cached = _MODEL_CACHE.get(cache_key)
    if cached is not None:
        return cached

    with _MODEL_LOAD_LOCK:
        cached = _MODEL_CACHE.get(cache_key)
        if cached is not None:
            return cached
        model, processor = _build_qwen_model(model_name, adapter_path)
        _MODEL_CACHE[cache_key] = (model, processor)
        return model, processor


CAPTION_PROMPT = (
    "Describe this satellite image for an Earth-observation analyst.\n"
    "Organise your answer under these headings, and keep each to one or two sentences:\n"
    "Land cover - what surface types are visibly present.\n"
    "Hydrology - water bodies, channels, flooding, or bare ground, or say none is visible.\n"
    "Urban density - built-up extent, road network, or absence of development.\n"
    "Vegetation health - density, colour and stress of vegetation, or absence of it.\n"
    "Rules: report only what you can actually see. Never invent percentages, area figures, "
    "class names or counts. If a heading has no supporting evidence, write "
    "\"not determinable from this image\". Separate direct observation from inference. "
    "Do not claim ground truth or field verification."
)


def run_vqa(
    image: Image.Image,
    question: str,
    model_name: str = DEFAULT_VQA_MODEL,
    adapter_path: str | None = None,
    max_new_tokens: int = 256,
) -> tuple[str, float]:
    """Run VQA inference using Qwen2-VL.

    `max_new_tokens` is a ceiling, not a target: `question` is expected to carry
    its own structure instruction, so a yes/no question can still be answered in
    a few tokens while an analytical question can use the full budget.

    Returns (answer, confidence) tuple.

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

    # Tokenizer/processor + generate + decode all share mutable model state and
    # are serialized so concurrent requests cannot corrupt or race them.
    with _INFERENCE_LOCK:
        text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        image_inputs, video_inputs = process_vision_info(messages)

        inputs = processor(
            text=[text],
            images=image_inputs,
            videos=video_inputs,
            padding=True,
            return_tensors="pt",
        ).to(device)

        with torch.inference_mode():
            output_ids = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                # Greedy decoding over a much longer budget can fall into a
                # repetition loop; a mild penalty suppresses that without
                # changing the deterministic character of the output.
                repetition_penalty=1.05,
            )

        output_ids = output_ids[:, inputs.input_ids.shape[1]:]
        answer = processor.batch_decode(output_ids, skip_special_tokens=True)[0].strip()

    confidence = _vqa_confidence(answer)
    return answer, confidence


def run_caption(
    image: Image.Image,
    model_name: str = DEFAULT_CAPTION_MODEL,
    adapter_path: str | None = None,
    max_new_tokens: int = 512,
) -> tuple[str, float]:
    """Run image captioning inference using Qwen2-VL.

    `max_new_tokens` is a ceiling, not a target; the prompt controls length.

    Returns (caption, confidence) tuple.

    Raises:
        VLMUnavailableError: when PyTorch / model weights are unavailable.
    """
    process_vision_info = _import_vision_utils()
    torch = _import_torch()
    model, processor = load_qwen_model(model_name, adapter_path)
    device = next(model.parameters()).device

    prompt = CAPTION_PROMPT

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": prompt},
            ],
        }
    ]

    # See run_vqa: processor + generate + decode are serialized.
    with _INFERENCE_LOCK:
        text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        image_inputs, video_inputs = process_vision_info(messages)

        inputs = processor(
            text=[text],
            images=image_inputs,
            videos=video_inputs,
            padding=True,
            return_tensors="pt",
        ).to(device)

        with torch.inference_mode():
            output_ids = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                # See run_vqa: guard against greedy repetition over the longer budget.
                repetition_penalty=1.05,
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
      - Short free-form phrase: 0.70
      - Long structured report: lower, because a long answer asserts more
        without any additional verification. A report is a description of what
        the model can see, not a measurement, so it must not inherit the
        confidence of a crisp factual answer.
    """
    if not answer:
        return 0.0
    if answer.strip().lower() in {"yes", "no"}:
        return 0.80
    words = answer.split()
    if len(words) <= 12:
        return 0.70
    if len(words) <= 60:
        return 0.55
    return 0.45


def _caption_confidence(caption: str) -> float:
    """Confidence heuristic for captions.
    
    Proxy based on caption length: very short outputs (<5 words)
    suggest incomplete generation.
    """
    words = caption.split()
    if len(words) < 5:
        return 0.50
    return 0.75
