"""POST /vqa endpoint.

Receives an uploaded image and a question, runs VQA inference,
and returns a short direct answer following RSVQA format.

Output schema (Section 8):
  {
    "tool": "vqa",
    "status": "success",
    "result": { "answer": "yes", "question": "Is there water?" },
    "evidence": { "image": { "filename": "..." }, "question": "..." },
    "confidence": 0.80,
    "metadata": { "filename": "...", "size_bytes": 43210, "model": "...", "adapter_used": false }
  }

answer format (Section 9, RSVQA): lowercase short word/phrase, no punctuation.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile

from app.common.http_utils import (
    InvalidFileError,
    error_output,
    read_upload_file,
    save_to_temp,
    validate_upload_ext,
)
from app.models.vlm_loader import DEFAULT_VQA_MODEL
from app.schemas.common import ToolOutput
from app.tools.vqa import VQAError, compute_vqa

logger = logging.getLogger(__name__)

router = APIRouter()

VQA_ADAPTER_PATH = os.environ.get("VQA_ADAPTER_PATH")


@router.post("/vqa")
async def vqa_endpoint(
    image: UploadFile = File(..., description="Input image (GeoTIFF, TIFF, PNG, or JPEG)"),
    question: str = Form(..., description="Question about the image (plain English)"),
):
    """Run Visual Question Answering on an uploaded image.

    Returns a short, direct answer (RSVQA format): "yes", "no", "3",
    "farmland", etc.  Never a paragraph.
    """
    filename = image.filename or "unknown"

    if not question or not question.strip():
        return error_output(
            "vqa",
            "Question text is required and cannot be empty.",
            confidence=0.0,
        )

    ext = validate_upload_ext(filename)
    if ext is None:
        return error_output(
            "vqa",
            (
                f"Unsupported file format '{Path(filename).suffix.lower()}'. "
                f"Supported: .tif, .tiff, .png, .jpg, .jpeg"
            ),
            confidence=0.0,
        )

    try:
        content = await read_upload_file(image)
    except InvalidFileError as exc:
        return error_output("vqa", str(exc), confidence=0.0)

    tmp_path: Path | None = None
    try:
        tmp_path = save_to_temp(content, ext)
        result = compute_vqa(
            tmp_path,
            question.strip(),
            adapter_path=VQA_ADAPTER_PATH,
        )
    except VQAError as exc:
        return error_output("vqa", str(exc), confidence=0.0)
    except Exception as exc:
        logger.error("Unexpected VQA error: %s", exc, exc_info=True)
        return error_output("vqa", f"Internal error: {exc}", confidence=0.0)
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)

    return ToolOutput(
        tool="vqa",
        status="success",
        result={
            "answer": result["answer"],
            "question": result["question"],
        },
        evidence={
            "image": {"filename": filename},
            "question": result["question"],
        },
        confidence=result["confidence"],
        metadata={
            "filename": filename,
            "size_bytes": len(content),
            "model": DEFAULT_VQA_MODEL,
            "adapter_used": VQA_ADAPTER_PATH is not None,
        },
    )
