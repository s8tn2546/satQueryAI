"""POST /caption endpoint.

Receives an uploaded image and generates a natural language description
following VRSBench captioning format.

Output schema (Section 8):
  {
    "tool": "caption",
    "status": "success",
    "result": { "caption": "a satellite image of a farmland area with..." },
    "evidence": { "image": { "filename": "..." } },
    "confidence": 0.75,
    "metadata": { "filename": "...", "size_bytes": 43210, "model": "...", "adapter_used": false }
  }

caption format (Section 9, VRSBench): natural English sentence/paragraph,
scored via BLEU/CIDEr. Descriptive but not padded.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import APIRouter, File, UploadFile

from app.common.http_utils import (
    InvalidFileError,
    error_output,
    read_upload_file,
    save_to_temp,
    validate_upload_ext,
)
from app.models.vlm_loader import DEFAULT_CAPTION_MODEL, VLMUnavailableError
from app.schemas.common import ToolOutput
from app.tools.caption import CaptionError, compute_caption

logger = logging.getLogger(__name__)

router = APIRouter()

CAPTION_ADAPTER_PATH = os.environ.get("CAPTION_ADAPTER_PATH")


def _adapter_detected() -> bool:
    """True only if a LoRA adapter is configured AND present on disk."""
    return bool(CAPTION_ADAPTER_PATH) and Path(CAPTION_ADAPTER_PATH).exists()


def _offline_caption_output(
    filename: str,
    size_bytes: int,
    exc: VLMUnavailableError,
) -> ToolOutput:
    """Clearly-labeled offline placeholder when real VLM inference is unavailable.

    No visual analysis is performed and none is implied: this is an honest
    mock, not a model result, so confidence is 0.0 and no image content is
    invented (a truthful caption cannot be produced offline).
    """
    note = (
        "Real VLM inference is unavailable in this environment (missing "
        "dependencies or model weights). No visual analysis was performed; "
        "this is a labeled offline placeholder, not a model result."
    )
    return ToolOutput(
        tool="caption",
        status="success",
        result={
            "caption": "offline-placeholder",
            "note": note,
        },
        evidence={
            "image": {"filename": filename},
        },
        confidence=0.0,
        metadata={
            "filename": filename,
            "size_bytes": size_bytes,
            "model": DEFAULT_CAPTION_MODEL,
            "adapter_used": False,
            "mock": True,
            "offline": True,
            "reason": str(exc),
            "note": note,
        },
    )


@router.post("/caption")
async def caption_endpoint(
    image: UploadFile = File(..., description="Input image (GeoTIFF, TIFF, PNG, or JPEG)"),
):
    """Generate a caption for an uploaded satellite image.

    Returns a natural English sentence describing the image content (VRSBench
    captioning format, scored via BLEU/CIDEr-style metrics).
    """
    filename = image.filename or "unknown"

    ext = validate_upload_ext(filename)
    if ext is None:
        return error_output(
            "caption",
            (
                f"Unsupported file format '{Path(filename).suffix.lower()}'. "
                f"Supported: .tif, .tiff, .png, .jpg, .jpeg"
            ),
            confidence=0.0,
        )

    try:
        content = await read_upload_file(image)
    except InvalidFileError as exc:
        return error_output("caption", str(exc), confidence=0.0)

    tmp_path: Path | None = None
    try:
        tmp_path = save_to_temp(content, ext)
        result = compute_caption(
            tmp_path,
            adapter_path=CAPTION_ADAPTER_PATH,
        )
    except VLMUnavailableError as exc:
        return _offline_caption_output(
            filename, len(content), exc
        )
    except CaptionError as exc:
        return error_output("caption", str(exc), confidence=0.0)
    except Exception as exc:
        logger.error("Unexpected caption error: %s", exc, exc_info=True)
        return error_output("caption", f"Internal error: {exc}", confidence=0.0)
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)

    return ToolOutput(
        tool="caption",
        status="success",
        result={
            "caption": result["caption"],
        },
        evidence={
            "image": {"filename": filename},
        },
        confidence=result["confidence"],
        metadata={
            "filename": filename,
            "size_bytes": len(content),
            "model": DEFAULT_CAPTION_MODEL,
            "adapter_used": _adapter_detected(),
        },
    )
