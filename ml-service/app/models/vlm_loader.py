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

import torch
from PIL import Image
from qwen_vl_utils import process_vision_info

logger = logging.getLogger(__name__)

_MODEL_CACHE: dict[str, Any] = {}

DEFAULT_MODEL = os.environ.get("VLM_MODEL", "Qwen/Qwen2-VL-2B-Instruct")


def _device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _dtype_for(device: torch.device) -> torch.dtype:
    return torch.bfloat16 if device.type == "cuda" else torch.float32


def load_qwen_model(model_name: str = DEFAULT_MODEL, adapter_path: str | None = None) -> tuple[Any, Any]:
    """Load (and cache) the Qwen2-VL model + processor.
    
    Returns (model, processor) tuple. If adapter_path is provided,
    loads LoRA weights on top of the base model.
    """
    cache_key = f"qwen:{model_name}:{adapter_path or 'base'}"
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]

    from transformers import Qwen2VLForConditionalGeneration, AutoProcessor

    logger.info("Loading Qwen2-VL model: %s", model_name)
    device = _device()
    dtype = _dtype_for(device)

    processor = AutoProcessor.from_pretrained(model_name)
    model = Qwen2VLForConditionalGeneration.from_pretrained(
        model_name,
        torch_dtype=dtype,
        device_map="auto" if device.type == "cuda" else None,
    )

    if adapter_path and Path(adapter_path).exists():
        logger.info("Applying LoRA adapter from: %s", adapter_path)
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter_path)

    if device.type == "cpu":
        model.to(device)
    
    model.eval()
    _MODEL_CACHE[cache_key] = (model, processor)
    logger.info("Qwen2-VL model ready on %s (dtype=%s)", device, dtype)
    return model, processor


def run_vqa(
    image: Image.Image,
    question: str,
    model_name: str = DEFAULT_MODEL,
    adapter_path: str | None = None,
) -> tuple[str, float]:
    """Run VQA inference using Qwen2-VL.

    Returns (answer, confidence) tuple. Answer is lowercase, trimmed,
    matching RSVQA expected format (single word or short phrase like
    "yes", "no", "3", "farmland").
    """
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
    model_name: str = DEFAULT_MODEL,
    adapter_path: str | None = None,
) -> tuple[str, float]:
    """Run image captioning inference using Qwen2-VL.

    Returns (caption, confidence) tuple. Caption is a natural English
    sentence as required by VRSBench BLEU/CIDEr evaluation.
    """
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
