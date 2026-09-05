"""Visual Question Answering (VQA) tool.

Loads a satellite image, runs VQA inference with a VLM, and returns
a short direct answer following RSVQA benchmark format.

VQA answer format (Section 9, RSVQA):
  "yes" | "no" | "3" | "farmland" | ...
  Not a paragraph — single word or short phrase, lowercase.
"""

from __future__ import annotations

import logging
from pathlib import Path

from app.models.vlm_loader import DEFAULT_VQA_MODEL, run_vqa
from app.preprocessing.loader import ImageLoadError, load_image_as_pil

logger = logging.getLogger(__name__)


class VQAError(Exception):
    pass


def compute_vqa(
    image_path: str | Path,
    question: str,
    *,
    model_name: str = DEFAULT_VQA_MODEL,
    adapter_path: str | None = None,
) -> dict:
    """Run VQA on a single image.

    Args:
        image_path: Path to the input image (GeoTIFF, TIFF, PNG, or JPEG)
        question:   Question text (plain English)
        model_name: HuggingFace model ID; defaults to blip-vqa-base
        adapter_path: Optional path to LoRA adapter checkpoint

    Returns:
        {
            "answer":   str  — lowercase, short answer (RSVQA format)
            "question": str  — echoed back for evidence
            "confidence": float
        }

    Raises:
        VQAError: On image load failure or inference failure
    """
    try:
        pil_image = load_image_as_pil(Path(image_path))
    except ImageLoadError as exc:
        raise VQAError(f"Failed to load image: {exc}") from exc
    except Exception as exc:
        raise VQAError(f"Unexpected error loading image: {exc}") from exc

    if pil_image.mode != "RGB":
        pil_image = pil_image.convert("RGB")

    try:
        answer, confidence = run_vqa(pil_image, question, model_name=model_name, adapter_path=adapter_path)
    except Exception as exc:
        raise VQAError(f"VQA inference failed: {exc}") from exc

    return {
        "answer": answer,
        "question": question,
        "confidence": confidence,
    }
