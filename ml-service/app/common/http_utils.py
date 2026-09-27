"""Shared FastAPI helpers for handling uploaded raster files.

Both spectral-index and area endpoints accept a multipart file upload,
write it to a temporary file, and clean it up afterwards. This module
centralises that flow so the API routes stay small and consistent.
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path

from fastapi import UploadFile

from app.schemas.common import ToolOutput
from app.tools.roi_crop import RoiCropError

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {".tif", ".tiff", ".png", ".jpg", ".jpeg"}
MAX_FILE_SIZE_MB = 500

# One description for the AOI form field across every endpoint, so the OpenAPI
# schema tells the same story everywhere.
AOI_FORM_DESCRIPTION = (
    "Optional JSON-stringified GeoJSON Polygon/MultiPolygon defining the region of "
    "interest. When supplied the raster is genuinely cropped and polygon-masked "
    "before the tool reads any pixel. A bare GeoJSON geometry is interpreted as "
    "WGS84 (RFC 7946) and the resolved CRS is reported back."
)
AOI_CRS_FORM_DESCRIPTION = (
    "Optional explicit CRS of the AOI coordinates (e.g. 'EPSG:32643'). Overrides any "
    "'crs' member on the geometry and the RFC 7946 default."
)


def validate_upload_ext(filename: str | None) -> str | None:
    """Validate a filename's extension.

    Returns the lowercase extension (e.g. '.tif') if supported,
    otherwise None.
    """
    name = filename or "unknown"
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        return None
    return ext


class UploadError(Exception):
    """Base exception for upload processing errors."""


class InvalidFileError(UploadError):
    """Raised when an uploaded file is not a valid raster."""


class FileTooLargeError(UploadError):
    """Raised when an uploaded file exceeds the size limit."""


def parse_aoi_geometry(value: str | None) -> dict:
    """Echo the raw AOI scope that arrived as a form field into tool metadata.

    The frontend sends the drawn region of interest as a JSON-stringified
    GeoJSON geometry in the ``aoi_geometry`` form field. This records exactly
    what was requested, unmodified, so the requested scope is visible in
    evidence/trace even when the AOI could not be applied (a failure response
    should still show what was asked for).

    This is reporting only. Applying the AOI to the raster is the job of
    :func:`app.tools.roi_crop.aoi_scope`, which the tools call; see
    :func:`aoi_error_output` for structured AOI failures.
    """
    import json

    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {"aoi_geometry": value}
    if isinstance(parsed, (dict, list)):
        return {"aoi_geometry": parsed}
    return {"aoi_geometry": value}


def aoi_metadata(result: dict, raw_aoi: str | None) -> dict:
    """Build the ``metadata`` AOI block for a successful tool response.

    Prefers the AOI report produced by the tool (which describes what was
    actually applied: cropped dimensions, pixel counts, resolved CRS) and always
    includes the raw requested geometry for traceability.
    """
    metadata: dict = parse_aoi_geometry(raw_aoi)
    report = result.get("aoi") if isinstance(result, dict) else None
    if isinstance(report, dict):
        metadata["aoi"] = report
    return metadata


def spatial_metadata(result: dict | None) -> dict:
    """Standardized spatial-readiness block for ``ToolOutput.metadata``.

    Built from the AOI report the shared AOI layer already attaches to every
    tool result (``result["aoi"]``), which is populated exclusively from values
    read out of the raster itself. Nothing is defaulted, coerced or inferred:
    a raster with no CRS reports ``crs: None`` rather than a plausible default,
    and one with no transform reports ``resolution: None`` rather than the
    identity matrix's 1.0.

    ``isGeoreferenced`` is the load-bearing field: the single truthful answer to
    "do this result's coordinates mean anything?", derived from an actual CRS
    *and* a non-identity transform. Consumers use it instead of inferring
    georeferencing from an absent field.

    Accepts two result shapes. Most tools attach the shared AOI report under
    ``result["aoi"]``; ``/validate`` instead returns a ``ValidateResult``, whose
    spatial fields sit at the top level and already carry an explicit
    ``integrity`` verdict. Both are mapped to the same block so a consumer can
    read ``isGeoreferenced`` the same way regardless of which endpoint produced
    the result.
    """
    if result and "validation_status" in result:
        return _validation_spatial_block(result)

    report = (result or {}).get("aoi")
    report = report if isinstance(report, dict) else {}

    # Bi-temporal / bi-modal tools report one scope per input. Surface each
    # input's own spatial facts rather than collapsing them to a single claim:
    # two images can differ, and averaging or picking one would misreport.
    images = report.get("images")
    if isinstance(images, list) and images:
        per_image = {}
        for entry in images:
            if not isinstance(entry, dict):
                continue
            dims = entry.get("originalDimensions") or {}
            per_image[str(entry.get("image") or "image")] = {
                "isGeoreferenced": entry.get("isGeoreferenced"),
                "crs": entry.get("crs"),
                "resolution": entry.get("resolution"),
                "width": dims.get("width"),
                "height": dims.get("height"),
                "bandCount": entry.get("bandCount"),
                "bounds": entry.get("originalBounds"),
                "dataQuality": entry.get("aoiStatus"),
            }
        return {
            "isGeoreferenced": report.get("isGeoreferenced"),
            "images": per_image,
            "dataQuality": report.get("aoiStatus"),
        }

    dimensions = report.get("originalDimensions") or {}

    block: dict = {
        "isGeoreferenced": report.get("isGeoreferenced"),
        "crs": report.get("crs"),
        "resolution": report.get("resolution"),
        "width": dimensions.get("width"),
        "height": dimensions.get("height"),
        "bandCount": report.get("bandCount"),
        # Original (whole-scene) footprint; never the identity-implied bounds
        # rasterio substitutes for a raster with no transform.
        "bounds": report.get("originalBounds"),
        "dataQuality": report.get("aoiStatus"),
    }

    if block["isGeoreferenced"] is False:
        # Say *why* the spatial values are absent, so a consumer does not read
        # the nulls as a bug or fall back to assuming EPSG:4326.
        block["spatialMetadataUnavailable"] = (
            "The raster is not georeferenced (no CRS and/or no geotransform), so no "
            "coordinates, bounds or ground resolution are available. None were "
            "inferred. Spatial measurements (area, AOI, overlap) are unavailable; "
            "pixel-domain analysis is still valid."
        )
    return block


def _validation_spatial_block(result: dict) -> dict:
    """Map a ``ValidateResult`` payload onto the shared spatial block.

    ``/validate`` is the endpoint that *establishes* spatial readiness, so it
    reports the verdict itself (``integrity``) alongside the raw spatial fields.
    ``bounds`` is the native-CRS footprint; ``wgs84_bounds`` is included
    separately so a consumer never has to assume which CRS it is looking at.
    """
    block: dict = {
        "isGeoreferenced": result.get("is_georeferenced"),
        "crs": result.get("crs"),
        "resolution": result.get("resolution"),
        "width": result.get("width"),
        "height": result.get("height"),
        "bandCount": result.get("band_count"),
        "bounds": result.get("bounds"),
        # The authoritative readiness verdict for this file.
        "dataQuality": result.get("integrity"),
    }
    wgs84 = result.get("wgs84_bounds")
    if wgs84 is not None:
        block["wgs84Bounds"] = wgs84

    if block["isGeoreferenced"] is False:
        block["spatialMetadataUnavailable"] = (
            "The raster is not georeferenced (no CRS and/or no geotransform), so no "
            "coordinates, bounds or ground resolution are available. None were "
            "inferred. Spatial measurements (area, AOI, overlap) are unavailable; "
            "pixel-domain analysis is still valid."
        )
    return block


def aoi_error_output(
    tool: str,
    exc: "RoiCropError",
    *,
    raw_aoi: str | None = None,
) -> ToolOutput:
    """Build a structured failure ToolOutput for an AOI that could not be applied.

    An unusable AOI is never silently ignored: the response states why it was
    rejected, which part of the pipeline refused it, and the requested geometry,
    so the caller can correct the request instead of reading a whole-scene
    number as if it had been AOI-scoped.
    """
    metadata = parse_aoi_geometry(raw_aoi)
    report = dict(getattr(exc, "metadata", {}) or {})
    report.setdefault("aoiApplied", False)
    report.setdefault("aoiPresent", True)
    report.setdefault("reason", str(exc))
    metadata["aoi"] = report
    return ToolOutput(
        tool=tool,
        status="failed",
        result={"error": str(exc)},
        evidence={"aoi": report},
        confidence=0.0,
        metadata=metadata,
    )


async def read_upload_file(file: UploadFile) -> bytes:
    """Read and validate an uploaded file's size."""
    try:
        content = await file.read()
    except Exception as exc:
        raise InvalidFileError(f"Failed to read uploaded file: {exc}") from exc

    if len(content) > MAX_FILE_SIZE_MB * 1024 * 1024:
        raise FileTooLargeError(
            f"File too large: {len(content) / (1024 * 1024):.1f} MB "
            f"(max: {MAX_FILE_SIZE_MB} MB)"
        )
    if len(content) == 0:
        raise InvalidFileError("Uploaded file is empty (0 bytes)")
    return content


def save_to_temp(content: bytes, ext: str) -> Path:
    """Write bytes to a temp file and return its path."""
    suffix = ext if ext else ".tif"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        return Path(tmp.name)


def error_output(
    tool: str,
    message: str,
    *,
    detail: dict | None = None,
    status: str = "failed",
    confidence: float = 0.0,
    metadata: dict | None = None,
    evidence: dict | None = None,
) -> ToolOutput:
    """Build a structured ToolOutput representing a failure."""
    result: dict = {"error": message}
    if detail:
        result.update(detail)
    return ToolOutput(
        tool=tool,
        status=status,
        result=result,
        evidence=evidence or {},
        confidence=confidence,
        metadata=metadata or {},
    )
