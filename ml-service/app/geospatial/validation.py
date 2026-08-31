"""Image validation pipeline.

Validates raster/image files by inspecting file integrity, raster
properties, geospatial metadata, band information, and data quality.
This is the central quality gate for all imagery entering the system.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from app.geospatial.crs import bounds_to_wgs84, crs_to_string, parse_crs
from app.geospatial.raster_io import (
    RasterCorruptError,
    RasterFormatError,
    RasterNotFoundError,
    is_raster_empty,
    open_raster,
    read_metadata,
)
from app.preprocessing.band_detection import (
    BandDetectionResult,
    detect_bands,
    detect_modality_from_bands,
)
from app.preprocessing.loader import ImageLoadError, can_read_as_raster, load_metadata
from app.schemas.common import (
    BandInfo,
    Bounds,
    Modality,
    Resolution,
    ValidateResult,
    ValidationStatus,
)

logger = logging.getLogger(__name__)


class ValidationResult:
    """Mutable accumulator for validation findings."""

    def __init__(self) -> None:
        self.warnings: list[str] = []
        self.errors: list[str] = []
        self.status: ValidationStatus = ValidationStatus.VALID

    def add_warning(self, msg: str) -> None:
        self.warnings.append(msg)
        if self.status == ValidationStatus.VALID:
            self.status = ValidationStatus.WARNING

    def add_error(self, msg: str) -> None:
        self.errors.append(msg)
        self.status = ValidationStatus.INVALID


def validate_file(path: str | Path) -> tuple[ValidationResult, dict[str, Any] | None]:
    """Validate a file at the filesystem level.

    Returns (validation_result, metadata_dict_or_None).
    If validation fails at this stage, metadata is None.
    """
    vr = ValidationResult()
    path = Path(path)

    if not path.exists():
        vr.add_error(f"File not found: {path}")
        return vr, None

    if not path.is_file():
        vr.add_error(f"Path is not a regular file: {path}")
        return vr, None

    if path.stat().st_size == 0:
        vr.add_error("File is empty (0 bytes)")
        return vr, None

    if not can_read_as_raster(path):
        vr.add_error(
            f"Unsupported or unreadable format. "
            f"File extension: '{path.suffix}'. "
            f"Supported: .tif, .tiff, .png, .jpeg, .jpg"
        )
        return vr, None

    try:
        metadata = read_metadata(path)
    except RasterFormatError as exc:
        vr.add_error(f"Cannot read as raster: {exc}")
        return vr, None
    except RasterCorruptError as exc:
        vr.add_error(f"Corrupt raster: {exc}")
        return vr, None
    except Exception as exc:
        vr.add_error(f"Unexpected error reading raster: {exc}")
        return vr, None

    return vr, metadata


def validate_raster_properties(
    metadata: dict[str, Any],
) -> ValidationResult:
    """Validate raster-level properties from extracted metadata."""
    vr = ValidationResult()

    width = metadata.get("width", 0)
    height = metadata.get("height", 0)

    if width <= 0 or height <= 0:
        vr.add_error(f"Invalid raster dimensions: {width}x{height}")
        return vr

    band_count = metadata.get("band_count", 0)
    if band_count <= 0:
        vr.add_error(f"Invalid band count: {band_count}")
        return vr

    if band_count > 100:
        vr.add_warning(f"Unusually high band count ({band_count}). Verify file integrity.")

    dtype = metadata.get("dtype", "")
    if not dtype:
        vr.add_warning("Data type (dtype) could not be determined.")

    return vr


def validate_geospatial_metadata(
    metadata: dict[str, Any],
) -> ValidationResult:
    """Validate geospatial metadata: CRS, bounds, resolution."""
    vr = ValidationResult()

    crs = metadata.get("crs")
    is_georeferenced = metadata.get("is_georeferenced", False)

    if not is_georeferenced or crs is None:
        vr.add_warning(
            "No geospatial metadata (CRS/transform) found. "
            "This image is not georeferenced. Geographic operations "
            "will not be available."
        )

    bounds = metadata.get("bounds")
    if bounds is None and is_georeferenced:
        vr.add_warning("Georeferenced but bounds could not be extracted.")

    resolution = metadata.get("resolution")
    if resolution is None and is_georeferenced:
        vr.add_warning("Georeferenced but pixel resolution could not be determined.")
    elif resolution is not None:
        rx = resolution.get("x", 0)
        ry = resolution.get("y", 0)
        if rx <= 0 or ry <= 0:
            vr.add_error(f"Invalid pixel resolution: x={rx}, y={ry}")
        elif rx > 1000 or ry > 1000:
            vr.add_warning(
                f"Unusually large pixel resolution ({rx} x {ry} units). "
                "Verify CRS and resolution units."
            )

    return vr


def validate_bands(
    metadata: dict[str, Any],
    modality_hint: str | None = None,
) -> tuple[ValidationResult, BandDetectionResult, str]:
    """Validate band structure and detect modality."""
    vr = ValidationResult()

    band_count = metadata.get("band_count", 0)
    descriptions = metadata.get("descriptions", [])
    crs_obj = metadata.get("crs")
    crs_string = crs_to_string(crs_obj) if crs_obj else None

    band_result = detect_bands(
        band_descriptions=descriptions,
        band_count=band_count,
        crs_string=crs_string,
    )

    if modality_hint and modality_hint.lower() in ("optical", "sar"):
        modality = Modality(modality_hint.lower())
    else:
        modality_str = detect_modality_from_bands(descriptions, band_count)
        modality = Modality(modality_str)

    for warning in band_result.warnings:
        vr.add_warning(warning)

    return vr, band_result, modality.value


def validate_data_quality(
    path: str | Path,
    metadata: dict[str, Any],
) -> ValidationResult:
    """Check data quality: empty rasters, all-nodata, suspicious values."""
    vr = ValidationResult()

    try:
        if is_raster_empty(path):
            vr.add_error(
                "Raster contains only nodata values across all bands. "
                "The image has no usable data."
            )
    except Exception:
        vr.add_warning("Could not verify raster emptiness.")

    return vr


def run_validation(
    path: str | Path,
    modality_hint: str | None = None,
) -> ValidateResult:
    """Run the complete validation pipeline on a single image file.

    Returns a structured ValidateResult with all findings.
    """
    path = Path(path)

    # Step 1: File-level validation
    file_vr, metadata = validate_file(path)
    if file_vr.status == ValidationStatus.INVALID:
        return ValidateResult(
            valid=False,
            validation_status=ValidationStatus.INVALID,
            errors=file_vr.errors,
            warnings=file_vr.warnings,
            format=path.suffix.lstrip(".").upper() if path.suffix else "unknown",
        )

    assert metadata is not None  # guaranteed if file_vr is not invalid

    # Step 2: Raster property validation
    prop_vr = validate_raster_properties(metadata)
    if prop_vr.status == ValidationStatus.INVALID:
        return ValidateResult(
            valid=False,
            validation_status=ValidationStatus.INVALID,
            width=metadata.get("width", 0),
            height=metadata.get("height", 0),
            band_count=metadata.get("band_count", 0),
            dtype=metadata.get("dtype", ""),
            format=metadata.get("driver", path.suffix.lstrip(".")),
            errors=prop_vr.errors,
            warnings=file_vr.warnings + prop_vr.warnings,
        )

    # Step 3: Geospatial metadata validation
    geo_vr = validate_geospatial_metadata(metadata)

    # Step 4: Band validation
    band_vr, band_result, modality = validate_bands(metadata, modality_hint)

    # Step 5: Data quality checks
    quality_vr = validate_data_quality(path, metadata)
    if quality_vr.status == ValidationStatus.INVALID:
        return ValidateResult(
            valid=False,
            validation_status=ValidationStatus.INVALID,
            width=metadata.get("width", 0),
            height=metadata.get("height", 0),
            band_count=metadata.get("band_count", 0),
            modality=Modality(modality),
            dtype=metadata.get("dtype", ""),
            format=metadata.get("driver", path.suffix.lstrip(".")),
            errors=quality_vr.errors,
            warnings=(
                file_vr.warnings + prop_vr.warnings +
                geo_vr.warnings + band_vr.warnings
            ),
        )

    # Step 6: CRS and bounds conversion
    crs_obj = metadata.get("crs")
    crs_str = crs_to_string(crs_obj) if crs_obj else None
    bounds_dict = metadata.get("bounds")
    wgs84_bounds_dict = None
    if bounds_dict and crs_obj:
        wgs84_bounds_dict = bounds_to_wgs84(bounds_dict, crs_obj)

    # Build result objects
    bounds = None
    if bounds_dict:
        bounds = Bounds(**bounds_dict)

    wgs84_bounds = None
    if wgs84_bounds_dict:
        wgs84_bounds = Bounds(**wgs84_bounds_dict)

    resolution = None
    res_dict = metadata.get("resolution")
    if res_dict:
        resolution = Resolution(**res_dict)

    bands_info = [
        BandInfo(
            index=b.index,
            description=b.description,
            detected_name=b.detected_name,
            wavelength=b.wavelength,
        )
        for b in band_result.bands
    ]

    # Merge all warnings and errors
    all_warnings = (
        file_vr.warnings + prop_vr.warnings +
        geo_vr.warnings + band_vr.warnings
    )
    all_errors = file_vr.errors + prop_vr.errors + quality_vr.errors

    # Determine overall status. Band-identity warnings are informational
    # (an unlabeled band is still usable data) and do not downgrade a clean
    # file. File, raster-property, geospatial, and data-quality findings drive
    # the status.
    status_warnings = (
        file_vr.warnings + prop_vr.warnings + geo_vr.warnings + quality_vr.warnings
    )
    if all_errors:
        overall_status = ValidationStatus.INVALID
    elif status_warnings:
        overall_status = ValidationStatus.WARNING
    else:
        overall_status = ValidationStatus.VALID

    is_valid = overall_status != ValidationStatus.INVALID

    return ValidateResult(
        valid=is_valid,
        validation_status=overall_status,
        modality=Modality(modality),
        format=metadata.get("driver", path.suffix.lstrip(".")),
        width=metadata.get("width", 0),
        height=metadata.get("height", 0),
        band_count=metadata.get("band_count", 0),
        bands=bands_info,
        crs=crs_str,
        bounds=bounds,
        wgs84_bounds=wgs84_bounds,
        resolution=resolution,
        nodata=metadata.get("nodata"),
        dtype=metadata.get("dtype", ""),
        warnings=all_warnings,
        errors=all_errors,
    )
