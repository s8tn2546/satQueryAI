"""POST /validate endpoint.

Receives an uploaded image file, runs it through the validation
pipeline, and returns structured JSON results.
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse

from app.geospatial.validation import run_validation
from app.schemas.common import ToolOutput, ValidationStatus

logger = logging.getLogger(__name__)

router = APIRouter()

ALLOWED_EXTENSIONS = {".tif", ".tiff", ".png", ".jpg", ".jpeg"}
MAX_FILE_SIZE_MB = 500


@router.post("/validate")
async def validate_image(
    file: UploadFile = File(..., description="Image or raster file to validate"),
    modality_hint: str | None = Form(
        default=None,
        description="Optional modality hint: 'optical' or 'sar'",
    ),
) -> ToolOutput:
    """Validate an uploaded image/raster file.

    Returns structured metadata and validation results following the
    standard tool output schema.
    """
    # Validate file extension
    filename = file.filename or "unknown"
    ext = Path(filename).suffix.lower()

    if ext not in ALLOWED_EXTENSIONS:
        return ToolOutput(
            tool="validate",
            status="success",
            result={
                "valid": False,
                "validation_status": ValidationStatus.INVALID.value,
                "errors": [
                    f"Unsupported file format: '{ext}'. "
                    f"Supported: {sorted(ALLOWED_EXTENSIONS)}"
                ],
                "warnings": [],
                "format": ext.lstrip(".").upper(),
            },
            confidence=1.0,
        )

    # Validate modality hint
    if modality_hint and modality_hint.lower() not in ("optical", "sar"):
        return ToolOutput(
            tool="validate",
            status="success",
            result={
                "valid": False,
                "validation_status": ValidationStatus.INVALID.value,
                "errors": [
                    f"Invalid modality_hint: '{modality_hint}'. Must be 'optical' or 'sar'."
                ],
                "warnings": [],
            },
            confidence=1.0,
        )

    # Read file content and write to temp file
    try:
        content = await file.read()
    except Exception as exc:
        logger.error("Failed to read uploaded file: %s", exc)
        return ToolOutput(
            tool="validate",
            status="success",
            result={
                "valid": False,
                "validation_status": ValidationStatus.INVALID.value,
                "errors": [f"Failed to read uploaded file: {exc}"],
                "warnings": [],
            },
            confidence=1.0,
        )

    if len(content) > MAX_FILE_SIZE_MB * 1024 * 1024:
        return ToolOutput(
            tool="validate",
            status="success",
            result={
                "valid": False,
                "validation_status": ValidationStatus.INVALID.value,
                "errors": [
                    f"File too large: {len(content) / (1024*1024):.1f} MB "
                    f"(max: {MAX_FILE_SIZE_MB} MB)"
                ],
                "warnings": [],
            },
            confidence=1.0,
        )

    if len(content) == 0:
        return ToolOutput(
            tool="validate",
            status="success",
            result={
                "valid": False,
                "validation_status": ValidationStatus.INVALID.value,
                "errors": ["Uploaded file is empty (0 bytes)"],
                "warnings": [],
            },
            confidence=1.0,
        )

    # Write to temp file and validate
    try:
        suffix = ext if ext else ".tif"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(content)
            tmp_path = Path(tmp.name)

        try:
            vr = run_validation(tmp_path, modality_hint=modality_hint)
        finally:
            tmp_path.unlink(missing_ok=True)

    except Exception as exc:
        logger.error("Validation failed unexpectedly: %s", exc)
        return ToolOutput(
            tool="validate",
            status="success",
            result={
                "valid": False,
                "validation_status": ValidationStatus.INVALID.value,
                "errors": [f"Internal validation error: {exc}"],
                "warnings": [],
            },
            confidence=1.0,
        )

    # Build result dict from ValidateResult
    result_dict = vr.model_dump()

    # Compute confidence based on validation state
    if vr.validation_status == ValidationStatus.INVALID:
        confidence = 0.0
    elif vr.validation_status == ValidationStatus.WARNING:
        confidence = 0.7
    else:
        confidence = 1.0

    return ToolOutput(
        tool="validate",
        status="success",
        result=result_dict,
        evidence={"filename": filename},
        confidence=confidence,
        metadata={"filename": filename, "size_bytes": len(content)},
    )
