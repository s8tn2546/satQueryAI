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
