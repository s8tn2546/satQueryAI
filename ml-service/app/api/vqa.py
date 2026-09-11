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
from app.models.vlm_loader import (
    DEFAULT_VQA_MODEL,
    VLMUnavailableError,
    load_qwen_model,
)
from app.schemas.common import ToolOutput
from app.tools.vqa import VQAError, compute_vqa

logger = logging.getLogger(__name__)

router = APIRouter()

VQA_ADAPTER_PATH = os.environ.get("VQA_ADAPTER_PATH")


def _adapter_detected() -> bool:
    """True only if a LoRA adapter is configured AND present on disk."""
    return bool(VQA_ADAPTER_PATH) and Path(VQA_ADAPTER_PATH).exists()


def _offline_vqa_output(
    question: str,
    filename: str,
    size_bytes: int,
    exc: VLMUnavailableError,
) -> ToolOutput:
    """Clearly-labeled offline placeholder when real VLM inference is unavailable.

    No visual analysis is performed and none is implied: this is an honest
    mock, not a model answer, so confidence is 0.0 and no image facts are
    invented. The question is still echoed for request/response traceability.
    """
    note = (
        "Real VLM inference is unavailable in this environment (missing "
        "dependencies or model weights). No visual analysis was performed; "
        "this is a labeled offline placeholder, not a model result."
    )
    return ToolOutput(
        tool="vqa",
        status="success",
        result={
            "answer": "offline-placeholder",
            "question": question,
            "note": note,
        },
        evidence={
            "image": {"filename": filename},
            "question": question,
        },
        confidence=0.0,
        metadata={
            "filename": filename,
            "size_bytes": size_bytes,
            "model": DEFAULT_VQA_MODEL,
            "adapter_used": False,
            "mock": True,
            "offline": True,
            "reason": str(exc),
            "note": note,
        },
    )


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
    except VLMUnavailableError as exc:
        return _offline_vqa_output(
            question.strip(), filename, len(content), exc
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
            "adapter_used": _adapter_detected(),
        },
    )


@router.post("/vlm/warmup")
async def vlm_warmup():
    """Pre-load the VLM (base model + LoRA adapter) into the in-memory cache.

    Call once before a live demo so the first real VQA/caption request does
    not pay the cold model-load cost (~20-50s on CPU). Subsequent
    warm-vs-cold inference timing is reported. This performs no analysis.
    """
    from time import time

    t0 = time()
    try:
        model, _ = load_qwen_model(DEFAULT_VQA_MODEL, VQA_ADAPTER_PATH)
        from peft import PeftModel

        load_s = round(time() - t0, 1)
        return {
            "status": "ok",
            "model": DEFAULT_VQA_MODEL,
            "adapter_path": VQA_ADAPTER_PATH,
            "adapter_active": isinstance(model, PeftModel),
            "load_seconds": load_s,
        }
    except VLMUnavailableError as exc:
        return {"status": "unavailable", "reason": str(exc)}
