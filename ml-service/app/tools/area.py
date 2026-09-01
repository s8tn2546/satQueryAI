"""Area calculation from geospatial raster masks.

area = valid_pixel_count * (resolution_m ** 2)

Resolution and CRS must be read from the actual image metadata, never
assumed. For geographic (degree-based) CRS, computing an area from
pixel dimensions is not valid without reprojection, so a structured
warning/failure is returned instead of a wrong number.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import rasterio

from app.geospatial.crs import crs_is_geographic
from app.geospatial.raster_io import get_crs, read_metadata
from app.tools.band_utils import build_valid_mask


class AreaError(Exception):
    """Base exception for area computation errors."""


class AreaInputError(AreaError):
    """Raised when the raster cannot be used for area measurement."""


def _valid_pixel_count(path: Path, nodata: Any) -> int:
    """Count non-nodata, finite pixels using band 1.

    Band 1 is used only to derive the area mask; the area of the covered
    region is what is being measured.
    """
    with rasterio.open(str(path)) as src:
        array = src.read(1).astype(np.float64)
        if nodata is None:
            nodata = src.nodata

    valid = build_valid_mask(array, nodata)
    if not np.any(valid):
        raise AreaInputError("Raster contains no valid (non-nodata) pixels.")
    return int(np.count_nonzero(valid))


def compute_area(
    path: str | Path,
    feature_type: str = "",
) -> dict[str, Any]:
    """Compute the surface area covered by valid pixels in a raster.

    Args:
        path: Path to the raster file.
        feature_type: Optional label describing the feature being measured.

    Returns:
        A dict with area in m², km², hectares, the valid pixel count, and the
        resolution/CRS used. For geographic CRS this returns a structured
        failure explaining that deg*deg is not a valid area.
    """
    path = Path(path)
    try:
        metadata = read_metadata(path)
    except Exception as exc:
        raise AreaInputError(f"Could not read raster metadata: {exc}") from exc

    crs = get_crs(str(path))
    crs_string = str(crs) if crs else "undefined"

    # ---- Geographic CRS guard ----
    if crs is not None and crs_is_geographic(crs):
        return {
            "status": "failed",
            "area_km2": None,
            "area_ha": None,
            "area_m2": None,
            "valid_pixel_count": None,
            "resolution": metadata.get("resolution"),
            "crs": crs_string,
            "reason": (
                "The image uses a geographic (degree-based) coordinate system "
                f"({crs_string}). Computing area as deg x deg x pixel_count is "
                "not meaningful. Reproject to a projected CRS (e.g. UTM) or "
                "supply a projected image to obtain an area in m²/km²."
            ),
            "warnings": ["Area not computed; geographic CRS requires reprojection."],
        }

    # ---- Need resolution in real-world units (meters) ----
    res = metadata.get("resolution")
    if not res:
        raise AreaInputError(
            "No resolution available in the metadata; cannot compute area. "
            "Resolution must be read from the image, not assumed."
        )

    res_x = float(res.get("x"))
    res_y = float(res.get("y"))
    if res_x <= 0 or res_y <= 0:
        raise AreaInputError("Resolution must be positive meters per pixel.")

    # ---- Projected CRS: area = valid_pixel_count * pixel_area ----
    pixel_area = float(res_x * res_y)
    valid_count = _valid_pixel_count(path, metadata.get("nodata"))
    area_m2 = valid_count * pixel_area
    area_km2 = area_m2 / 1_000_000.0
    area_ha = area_m2 / 10_000.0

    warnings: list[str] = []
    confidence = 1.0

    if not crs:
        warnings.append(
            "The CRS is undefined; the resolution was interpreted as meters "
            "per pixel, which may be incorrect."
        )
        confidence = 0.7

    if abs(res_x - res_y) > 1e-9:
        warnings.append(
            "Pixel is not square (x and y resolution differ); area uses "
            f"x={res_x} x y={res_y}."
        )
        confidence = min(confidence, 0.9)

    return {
        "status": "success",
        "area_km2": round(area_km2, 6),
        "area_ha": round(area_ha, 4),
        "area_m2": round(area_m2, 2),
        "valid_pixel_count": valid_count,
        "total_pixel_count": int(metadata.get("width", 0) * metadata.get("height", 0)),
        "resolution_m": res_x,
        "resolution_y_m": res_y,
        "crs": crs_string,
        "feature_type": feature_type,
        "pixel_area_m2": round(pixel_area, 6),
        "warnings": warnings,
        "confidence": confidence,
    }


def area_confidence(area_result: dict[str, Any]) -> float:
    """Confidence from area result reliability (never random)."""
    if area_result.get("status") != "success":
        return 0.0
    return float(area_result.get("confidence", 1.0))
