"""Image captioning tool.

Generates natural language descriptions of satellite images using a VLM.

Caption format (Section 9, VRSBench):
  A natural English sentence/paragraph scored via BLEU/CIDEr-style metrics.
  Must be descriptive but not padded; aim for 10-60 words.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from app.models.vlm_loader import DEFAULT_CAPTION_MODEL, VLMUnavailableError, run_caption
from app.preprocessing.loader import ImageLoadError, load_image_as_pil
from app.tools.roi_crop import aoi_scope, attach_aoi

logger = logging.getLogger(__name__)


class CaptionError(Exception):
    pass


def compute_caption(
    image_path: str | Path,
    *,
    model_name: str = DEFAULT_CAPTION_MODEL,
    adapter_path: str | None = None,
    aoi: Any = None,
    aoi_crs: Any = None,
) -> dict:
    """Generate a caption for a satellite image, restricted to an AOI.

    As with VQA, a VLM captions a rectangular image, so an AOI is applied as its
    pixel bounding window and reported as ``raster_window`` rather than
    ``raster_window+mask``.

    Args:
        image_path:  Path to the input image (GeoTIFF, TIFF, PNG, or JPEG)
        model_name:  HuggingFace model ID; defaults to the configured caption
            model (Qwen/Qwen2-VL-2B-Instruct via DEFAULT_CAPTION_MODEL)
        adapter_path: Optional path to LoRA adapter checkpoint
        aoi: optional GeoJSON Polygon/MultiPolygon (or JSON string) region of
            interest. When absent the whole image is captioned.
        aoi_crs: optional explicit CRS of the AOI coordinates. A bare GeoJSON
            geometry follows RFC 7946 (WGS84); the resolved CRS is reported in
            ``result["aoi"]``.

    Returns:
        {
            "caption":    str   — natural English sentence
            "confidence": float
            "aoi":        dict  — AOI reporting (aoiScope = "raster_window")
        }

    Raises:
        CaptionError: On image load failure or inference failure
        RoiCropError: When the AOI cannot be applied to the image.
        VLMUnavailableError: When real VLM inference is unavailable
            (missing dependencies/weights); callers should use the labeled
            offline placeholder instead of treating this as a real caption.
    """
    with aoi_scope(image_path, aoi, aoi_crs=aoi_crs, apply_mask=False) as scope:
        result = _run_caption(
            scope.raster_path,
            model_name=model_name,
            adapter_path=adapter_path,
        )
    return attach_aoi(result, scope)


def _run_caption(
    image_path: Path,
    *,
    model_name: str,
    adapter_path: str | None,
) -> dict:
    """Load the (already AOI-scoped) image and run captioning on it."""
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
    except VLMUnavailableError:
        raise
    except Exception as exc:
        raise CaptionError(f"Caption generation failed: {exc}") from exc

    return {
        "caption": caption,
        "confidence": confidence,
    }
