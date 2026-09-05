"""Image captioning tool.

Generates natural language descriptions of satellite images using a VLM.

Caption format (Section 9, VRSBench):
  A natural English sentence/paragraph scored via BLEU/CIDEr-style metrics.
  Must be descriptive but not padded; aim for 10-60 words.
"""

from __future__ import annotations

import logging
from pathlib import Path

from app.models.vlm_loader import DEFAULT_CAPTION_MODEL, run_caption
from app.preprocessing.loader import ImageLoadError, load_image_as_pil

logger = logging.getLogger(__name__)


class CaptionError(Exception):
    pass


def compute_caption(
    image_path: str | Path,
    *,
    model_name: str = DEFAULT_CAPTION_MODEL,
    adapter_path: str | None = None,
) -> dict:
    """Generate a caption for a satellite image.

    Args:
        image_path:  Path to the input image (GeoTIFF, TIFF, PNG, or JPEG)
        model_name:  HuggingFace model ID; defaults to blip-image-captioning-base
        adapter_path: Optional path to LoRA adapter checkpoint

    Returns:
        {
            "caption":    str   — natural English sentence
            "confidence": float
        }

    Raises:
        CaptionError: On image load failure or inference failure
    """
    try:
        pil_image = load_image_as_pil(Path(image_path))
    except ImageLoadError as exc:
        raise CaptionError(f"Failed to load image: {exc}") from exc
    except Exception as exc:
        raise CaptionError(f"Unexpected error loading image: {exc}") from exc

    if pil_image.mode != "RGB":
        pil_image = pil_image.convert("RGB")

    try:
        caption, confidence = run_caption(pil_image, model_name=model_name, adapter_path=adapter_path)
    except Exception as exc:
        raise CaptionError(f"Caption generation failed: {exc}") from exc

    return {
        "caption": caption,
        "confidence": confidence,
    }
