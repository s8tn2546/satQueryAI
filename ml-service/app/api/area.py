"""POST /area endpoint.

Receives an uploaded raster, reads its resolution and CRS from metadata,
and computes the surface area covered by valid (non-nodata) pixels.
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
from app.tools.area import AreaInputError, compute_area

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/area")
async def area_endpoint(
    file: UploadFile = File(..., description="Georeferenced raster in a projected CRS"),
    feature_type: str | None = Form(
        default=None,
        description="Optional label describing the feature being measured",
    ),
):
    """Compute the surface area covered by valid pixels in an uploaded raster."""
    filename = file.filename or "unknown"

    ext = validate_upload_ext(filename)
    if ext is None:
        return error_output(
            "area",
            f"Unsupported file format: '{Path(filename).suffix.lower()}'. "
            f"Supported: {sorted({'tif', 'tiff', 'png', 'jpg', 'jpeg'})}",
        )

    try:
        content = await read_upload_file(file)
    except InvalidFileError as exc:
        return error_output("area", str(exc))

    tmp_path: Path | None = None
    try:
        tmp_path = save_to_temp(content, ext)
        result = compute_area(tmp_path, feature_type=feature_type or "")
    except AreaInputError as exc:
        return error_output("area", str(exc))
    except Exception as exc:
        logger.error("Area computation failed unexpectedly: %s", exc)
        return error_output("area", f"Internal area computation error: {exc}")
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)

    if result.get("status") == "failure":
        return error_output(
            "area",
            result.get("reason", "Area could not be computed."),
            detail={
                "crs": result.get("crs"),
                "resolution": result.get("resolution"),
                "warnings": result.get("warnings", []),
            },
            confidence=0.0,
        )

    return ToolOutput(
        tool="area",
        status="success",
        result=result,
        evidence={
            "filename": filename,
            "crs": result.get("crs"),
        },
        confidence=float(result.get("confidence", 1.0)),
        metadata={"filename": filename, "size_bytes": len(content)},
    )
