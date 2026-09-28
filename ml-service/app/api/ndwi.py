"""POST /ndwi endpoint.

Receives an uploaded multispectral image, resolves its GREEN and NIR bands
from explicit metadata, and computes the NDWI index.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile

from app.common.http_utils import (
    AOI_CRS_FORM_DESCRIPTION,
    AOI_FORM_DESCRIPTION,
    InvalidFileError,
    aoi_error_output,
    aoi_metadata,
    spatial_metadata,
    error_output,
    read_upload_file,
    save_to_temp,
    validate_upload_ext,
)
from app.common.safe_errors import safe_error
from app.geospatial.raster_io import RasterError
from app.schemas.common import ToolOutput
from app.tools.ndwi import NdwiInputError, compute_ndwi
from app.tools.roi_crop import RoiCropError

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/ndwi")
async def ndwi_endpoint(
    file: UploadFile = File(..., description="Multispectral raster with GREEN and NIR bands"),
    green_band: int | None = Form(
        default=None,
        description="Optional explicit 1-based GREEN band index (overrides auto-detection)",
    ),
    nir_band: int | None = Form(
        default=None,
        description="Optional explicit 1-based NIR band index (overrides auto-detection)",
    ),
    aoi_geometry: str | None = Form(default=None, description=AOI_FORM_DESCRIPTION),
    aoi_crs: str | None = Form(default=None, description=AOI_CRS_FORM_DESCRIPTION),
):
    """Compute NDWI for an uploaded multispectral image, optionally within an AOI."""
    filename = file.filename or "unknown"

    ext = validate_upload_ext(filename)
    if ext is None:
        return error_output(
            "ndwi",
            f"Unsupported file format: '{Path(filename).suffix.lower()}'. "
            f"Supported: {sorted({'tif', 'tiff', 'png', 'jpg', 'jpeg'})}",
        )

    try:
        content = await read_upload_file(file)
    except InvalidFileError as exc:
        return error_output("ndwi", safe_error(exc))

    band_overrides = None
    if green_band is not None or nir_band is not None:
        band_overrides = {
            "green": int(green_band) if green_band is not None else 0,
            "nir": int(nir_band) if nir_band is not None else 0,
        }

    tmp_path: Path | None = None
    try:
        tmp_path = save_to_temp(content, ext)
        result = compute_ndwi(
            tmp_path, band_overrides=band_overrides, aoi=aoi_geometry, aoi_crs=aoi_crs
        )
    except RoiCropError as exc:
        return aoi_error_output("ndwi", exc, raw_aoi=aoi_geometry)
    except RasterError as exc:
        return error_output("ndwi", safe_error(exc))
    except NdwiInputError as exc:
        return error_output("ndwi", safe_error(exc))
    except Exception as exc:
        logger.error("NDWI computation failed unexpectedly: %s", exc)
        return error_output("ndwi", f"Internal NDWI computation error: {safe_error(exc)}")
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)

    warnings = result.get("warnings", [])
    confidence = 1.0 if not warnings and result["valid_pixel_count"] > 0 else (
        0.8 if result["valid_pixel_count"] > 0 else 0.0
    )

    return ToolOutput(
        tool="ndwi",
        status="success",
        result=result,
        evidence={
            "filename": filename,
            "bands_used": result["bands"],
        },
        confidence=confidence,
        metadata={
            "filename": filename,
            "size_bytes": len(content),
            **spatial_metadata(result),
            **aoi_metadata(result, aoi_geometry),
        },
    )
