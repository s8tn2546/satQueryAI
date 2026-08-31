"""POST /change endpoint.

Receives two uploaded images (image1 = time 1, image2 = time 2), runs
bi-temporal change detection, and returns structured results following the
standard tool output schema.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile

from app.common.http_utils import (
    InvalidFileError,
    error_output,
    read_upload_file,
    save_to_temp,
    validate_upload_ext,
)
from app.schemas.common import ToolOutput
from app.tools.change import (
    ChangeError,
    ChangeValidationError,
    change_confidence,
    compute_change,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/change")
async def change_endpoint(
    image1: UploadFile = File(..., description="First image (earlier date, time 1)"),
    image2: UploadFile = File(..., description="Second image (later date, time 2)"),
    threshold: float | None = Form(
        default=None,
        description=(
            "Change threshold in data units. If omitted, a documented "
            "deterministic 2-sigma (two standard deviations of the valid pixel "
            "differences) default is used."
        ),
    ),
    band: int | None = Form(
        default=None,
        description="Optional explicit 1-based band index to compare in both images.",
    ),
    band_t1: int | None = Form(
        default=None,
        description="Optional explicit 1-based band index in image1.",
    ),
    band_t2: int | None = Form(
        default=None,
        description="Optional explicit 1-based band index in image2.",
    ),
):
    """Run bi-temporal change detection between two uploaded images."""
    filename1 = image1.filename or "unknown"
    filename2 = image2.filename or "unknown"

    if threshold is not None and threshold < 0:
        return error_output(
            "change",
            "Invalid threshold: must be >= 0.",
            confidence=0.0,
        )

    ext1 = validate_upload_ext(filename1)
    ext2 = validate_upload_ext(filename2)
    for label, ext in (("image1", ext1), ("image2", ext2)):
        if ext is None:
            return error_output(
                "change",
                f"Unsupported file format for {label}: "
                f"'{Path(filename1 if label == 'image1' else filename2).suffix.lower()}'. "
                f"Supported: {sorted({'tif', 'tiff', 'png', 'jpg', 'jpeg'})}",
                confidence=0.0,
            )

    try:
        content1 = await read_upload_file(image1)
        content2 = await read_upload_file(image2)
    except InvalidFileError as exc:
        return error_output("change", str(exc), confidence=0.0)

    tmp1: Path | None = None
    tmp2: Path | None = None
    try:
        tmp1 = save_to_temp(content1, ext1)
        tmp2 = save_to_temp(content2, ext2)
        result = compute_change(
            tmp1,
            tmp2,
            threshold=threshold,
            band=band,
            band_t1=band_t1,
            band_t2=band_t2,
        )
    except ChangeValidationError as exc:
        return error_output(
            "change",
            str(exc),
            confidence=0.0,
        )
    except ChangeError as exc:
        return error_output(
            "change",
            f"Change detection could not be completed: {exc}",
            confidence=0.0,
        )
    except Exception as exc:
        logger.error("Change detection failed unexpectedly: %s", exc)
        return error_output(
            "change",
            f"Internal change-detection error: {exc}",
            confidence=0.0,
        )
    finally:
        if tmp1 is not None:
            tmp1.unlink(missing_ok=True)
        if tmp2 is not None:
            tmp2.unlink(missing_ok=True)

    return ToolOutput(
        tool="change",
        status="success",
        result=result,
        evidence={
            "image1": {"filename": filename1},
            "image2": {"filename": filename2},
            "method": result.get("method"),
            "threshold": result.get("threshold"),
            "changed_area_km2": result.get("changed_area_km2"),
        },
        confidence=change_confidence(result),
        metadata={
            "filename1": filename1,
            "filename2": filename2,
            "size_bytes_1": len(content1),
            "size_bytes_2": len(content2),
            "comparison_band": result.get("comparison_band"),
        },
    )
