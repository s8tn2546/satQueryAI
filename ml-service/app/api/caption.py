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
from app.models.vlm_loader import DEFAULT_CAPTION_MODEL
from app.schemas.common import ToolOutput
from app.tools.caption import CaptionError, compute_caption

logger = logging.getLogger(__name__)

router = APIRouter()

CAPTION_ADAPTER_PATH = os.environ.get("CAPTION_ADAPTER_PATH")


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
            "adapter_used": CAPTION_ADAPTER_PATH is not None,
        },
    )
