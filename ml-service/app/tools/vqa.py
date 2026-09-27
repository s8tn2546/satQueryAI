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
from typing import Any

from app.models.vlm_loader import DEFAULT_VQA_MODEL, VLMUnavailableError, run_vqa
from app.preprocessing.loader import ImageLoadError, load_image_as_pil
from app.tools.roi_crop import aoi_scope, attach_aoi

logger = logging.getLogger(__name__)


class VQAError(Exception):
    pass


def compute_vqa(
    image_path: str | Path,
    question: str,
    *,
    model_name: str = DEFAULT_VQA_MODEL,
    adapter_path: str | None = None,
    aoi: Any = None,
    aoi_crs: Any = None,
) -> dict:
    """Run VQA on a single image, restricted to an AOI when one is given.

    A VLM answers about a rectangular image, so the AOI is applied as its pixel
    bounding window. The scope is reported as ``raster_window`` (never
    ``raster_window+mask``) so a reader is never told that polygon-level
    clipping happened when it did not: pixels inside the window but outside a
    non-rectangular AOI are still visible to the model.

    Args:
        image_path: Path to the input image (GeoTIFF, TIFF, PNG, or JPEG)
        question:   Question text (plain English)
        model_name: HuggingFace model ID; defaults to the configured VQA model
            (Qwen/Qwen2-VL-2B-Instruct via DEFAULT_VQA_MODEL)
        adapter_path: Optional path to LoRA adapter checkpoint
        aoi: optional GeoJSON Polygon/MultiPolygon (or JSON string) region of
            interest. When absent the whole image is shown to the model.
        aoi_crs: optional explicit CRS of the AOI coordinates. A bare GeoJSON
            geometry follows RFC 7946 (WGS84); the resolved CRS is reported in
            ``result["aoi"]``.

    Returns:
        {
            "answer":   str  — lowercase, short answer (RSVQA format)
            "question": str  — echoed back for evidence
            "confidence": float
            "aoi":      dict — AOI reporting (aoiScope = "raster_window")
        }

    Raises:
        VQAError: On image load failure or inference failure
        RoiCropError: When the AOI cannot be applied to the image.
        VLMUnavailableError: When real VLM inference is unavailable
            (missing dependencies/weights); callers should use the labeled
            offline placeholder instead of treating this as a model answer.
    """
    with aoi_scope(image_path, aoi, aoi_crs=aoi_crs, apply_mask=False) as scope:
        result = _run_vqa(
            scope.raster_path,
            question,
            model_name=model_name,
            adapter_path=adapter_path,
        )
    return attach_aoi(result, scope)


def _run_vqa(
    image_path: Path,
    question: str,
    *,
    model_name: str,
    adapter_path: str | None,
) -> dict:
    """Load the (already AOI-scoped) image and run VLM inference on it."""
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
    except VLMUnavailableError:
        raise
    except Exception as exc:
        raise VQAError(f"VQA inference failed: {exc}") from exc

    return {
        "answer": answer,
        "question": question,
        "confidence": confidence,
    }
