"""POST /optical-sar endpoint.

Receives two uploaded images (an optical image and a SAR image), runs
deterministic optical+SAR cross-modal analysis / fusion, and returns structured
results following the standard tool output schema.

Only quantitative (computational remote-sensing) evidence is produced here;
semantic interpretation ("flood", "deforestation", ...) is handled by the
Agent / VLM / ML layer (Member 5), not by this endpoint.
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
from app.geospatial.raster_io import RasterError
from app.schemas.common import ToolOutput
from app.tools.fusion import (
    FusionError,
    FusionValidationError,
    fusion_confidence,
    run_optical_sar_fusion,
)
from app.tools.roi_crop import RoiCropError

logger = logging.getLogger(__name__)

router = APIRouter()


def _validate_ext(label: str, filename: str | None):
    ext = validate_upload_ext(filename)
    if ext is None:
        return error_output(
            "optical-sar",
            f"Unsupported file format for {label}: "
            f"'{Path(filename or 'unknown').suffix.lower()}'. "
            f"Supported: {sorted({'tif', 'tiff', 'png', 'jpg', 'jpeg'})}",
            confidence=0.0,
        )
    return None


@router.post("/optical-sar")
async def optical_sar_endpoint(
    optical_image: UploadFile = File(
        ..., description="Optical (multispectral/rgb) raster image."
    ),
    sar_image: UploadFile = File(
        ..., description="SAR raster image (e.g. single-band backscatter, VV/VH)."
    ),
    optical_band: int | None = Form(
        default=None,
        description="Optional explicit 1-based optical band index to use as the feature.",
    ),
    sar_band: int | None = Form(
        default=None,
        description="Optional explicit 1-based SAR band index to analyze.",
    ),
    speckle_size: int | None = Form(
        default=None,
        description=(
            "Optional speckle-filter window size (odd integer >= 1). "
            "Defaults to a deterministic 3x3 median filter."
        ),
    ),
    sar_representation: str | None = Form(
        default=None,
        description=(
            "Optional caller-declared SAR value representation: "
            "'amplitude', 'power', 'db' or 'unknown'. Recorded as a "
            "caller-declared claim; it is never used to convert pixel values."
        ),
    ),
    sar_polarizations: str | None = Form(
        default=None,
        description=(
            "Optional comma-separated polarization names the SAR raster must "
            "provide (e.g. 'VV,VH'). A missing required polarization fails "
            "explicitly."
        ),
    ),
    aoi_geometry: str | None = Form(default=None, description=AOI_FORM_DESCRIPTION),
    aoi_crs: str | None = Form(default=None, description=AOI_CRS_FORM_DESCRIPTION),
):
    """Run optical + SAR cross-modal analysis between two uploaded images."""
    optical_filename = optical_image.filename or "unknown"
    sar_filename = sar_image.filename or "unknown"

    if optical_band is not None and optical_band < 1:
        return error_output(
            "optical-sar",
            "Invalid optical_band: must be a positive 1-based index.",
            confidence=0.0,
        )
    if sar_band is not None and sar_band < 1:
        return error_output(
            "optical-sar",
            "Invalid sar_band: must be a positive 1-based index.",
            confidence=0.0,
        )
    if speckle_size is not None and (speckle_size < 1 or speckle_size % 2 == 0):
        return error_output(
            "optical-sar",
            "Invalid speckle_size: must be an odd positive integer.",
            confidence=0.0,
        )

    allowed_sar_representations = {"amplitude", "power", "db", "unknown"}
    if (
        sar_representation is not None
        and sar_representation.strip().lower() not in allowed_sar_representations
    ):
        return error_output(
            "optical-sar",
            "Invalid sar_representation: must be one of "
            f"{sorted(allowed_sar_representations)}.",
            confidence=0.0,
        )

    allowed_polarizations = {"vv", "vh", "hh", "hv"}
    requested_polarizations = None
    if sar_polarizations is not None and sar_polarizations.strip():
        requested_polarizations = [
            name.strip() for name in sar_polarizations.split(",")
        ]
        bad = [name for name in requested_polarizations
               if name.lower() not in allowed_polarizations]
        if bad:
            return error_output(
                "optical-sar",
                "Invalid sar_polarizations: only VV, VH, HH, HV are recognized "
                f"(got: {', '.join(bad)}).",
                confidence=0.0,
            )

    ext_opt = _validate_ext("optical_image", optical_image.filename)
    if ext_opt is not None:
        return ext_opt
    ext_sar = _validate_ext("sar_image", sar_image.filename)
    if ext_sar is not None:
        return ext_sar

    try:
        content_opt = await read_upload_file(optical_image)
        content_sar = await read_upload_file(sar_image)
    except InvalidFileError as exc:
        return error_output("optical-sar", str(exc), confidence=0.0)

    tmp_opt: Path | None = None
    tmp_sar: Path | None = None
    try:
        tmp_opt = save_to_temp(content_opt, ext_opt)
        tmp_sar = save_to_temp(content_sar, ext_sar)
        result = run_optical_sar_fusion(
            tmp_opt,
            tmp_sar,
            optical_band=optical_band,
            sar_band=sar_band,
            speckle_size=speckle_size,
            sar_representation=(
                sar_representation.strip().lower() if sar_representation else None
            ),
            sar_polarizations=(
                ",".join(requested_polarizations)
                if requested_polarizations else None
            ),
            aoi=aoi_geometry,
            aoi_crs=aoi_crs,
        )
    except RoiCropError as exc:
        return aoi_error_output("optical-sar", exc, raw_aoi=aoi_geometry)
    except RasterError as exc:
        return error_output("optical-sar", str(exc), confidence=0.0)
    except FusionValidationError as exc:
        return error_output(
            "optical-sar",
            str(exc),
            confidence=0.0,
        )
    except FusionError as exc:
        return error_output(
            "optical-sar",
            f"Fusion could not be completed: {exc}",
            confidence=0.0,
        )
    except Exception as exc:
        logger.error("Optical/SAR fusion failed unexpectedly: %s", exc)
        return error_output(
            "optical-sar",
            f"Internal optical/SAR fusion error: {exc}",
            confidence=0.0,
        )
    finally:
        if tmp_opt is not None:
            tmp_opt.unlink(missing_ok=True)
        if tmp_sar is not None:
            tmp_sar.unlink(missing_ok=True)

    sar_block = result.get("sar", {})
    polarization_block = result.get("polarization", {}) if isinstance(result.get("polarization"), dict) else {}
    available_polarizations = [
        role.upper() for role, entry in polarization_block.items()
        if isinstance(entry, dict) and entry.get("available")
    ]

    return ToolOutput(
        tool="optical-sar",
        status="success",
        result=result,
        evidence={
            "optical_image": {"filename": optical_filename},
            "sar_image": {"filename": sar_filename},
            "alignment_method": result.get("alignment", {}).get("method"),
            "overlap_pixels": result.get("overlap", {}).get("valid_pixels"),
            "partial_overlap": result.get("overlap", {}).get("partial"),
            "sar_polarizations": available_polarizations,
            "sar_representation": sar_block.get("representation"),
        },
        confidence=fusion_confidence(result),
        metadata={
            "filename_optical": optical_filename,
            "filename_sar": sar_filename,
            "size_bytes_optical": len(content_opt),
            "size_bytes_sar": len(content_sar),
            "optical_feature": result.get("optical", {}).get("feature_basis"),
            "sar_band": sar_block.get("band"),
            "sar_polarization": sar_block.get("polarization"),
            "sar_polarizations_available": available_polarizations,
            "sar_representation": sar_block.get("representation"),
            "sar_representation_basis": sar_block.get("representation_basis"),
            "sar_units": sar_block.get("units"),
            **spatial_metadata(result),
            **aoi_metadata(result, aoi_geometry),
        },
    )
