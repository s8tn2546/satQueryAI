"""POST /ndvi endpoint.

Receives an uploaded multispectral image, resolves its RED and NIR bands
from explicit metadata, and computes the NDVI index.
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
from app.tools.ndvi import NdvInputError, compute_ndvi

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/ndvi")
async def ndvi_endpoint(
    file: UploadFile = File(..., description="Multispectral raster with RED and NIR bands"),
    red_band: int | None = Form(
        default=None,
        description="Optional explicit 1-based RED band index (overrides auto-detection)",
    ),
    nir_band: int | None = Form(
        default=None,
        description="Optional explicit 1-based NIR band index (overrides auto-detection)",
    ),
):
    """Compute NDVI for an uploaded multispectral image."""
    filename = file.filename or "unknown"

    ext = validate_upload_ext(filename)
    if ext is None:
        return error_output(
            "ndvi",
            f"Unsupported file format: '{Path(filename).suffix.lower()}'. "
            f"Supported: {sorted({'tif', 'tiff', 'png', 'jpg', 'jpeg'})}",
        )

    try:
        content = await read_upload_file(file)
    except InvalidFileError as exc:
        return error_output("ndvi", str(exc))

    band_overrides = None
    if red_band is not None or nir_band is not None:
        band_overrides = {
            "red": int(red_band) if red_band is not None else 0,
            "nir": int(nir_band) if nir_band is not None else 0,
        }

    tmp_path: Path | None = None
    try:
        tmp_path = save_to_temp(content, ext)
        result = compute_ndvi(tmp_path, band_overrides=band_overrides)
    except NdvInputError as exc:
        return error_output("ndvi", str(exc))
    except Exception as exc:
        logger.error("NDVI computation failed unexpectedly: %s", exc)
        return error_output("ndvi", f"Internal NDVI computation error: {exc}")
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)

    warnings = result.get("warnings", [])
    confidence = 1.0 if not warnings and result["valid_pixel_count"] > 0 else (
        0.8 if result["valid_pixel_count"] > 0 else 0.0
    )

    return ToolOutput(
        tool="ndvi",
        status="success",
        result=result,
        evidence={
            "filename": filename,
            "bands_used": result["bands"],
        },
        confidence=confidence,
        metadata={"filename": filename, "size_bytes": len(content)},
    )
