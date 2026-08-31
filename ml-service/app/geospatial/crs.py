"""CRS handling utilities using pyproj.

Provides functions for parsing, validating, and converting
coordinate reference systems. Never silently assumes EPSG:4326.
"""

from __future__ import annotations

import logging
from typing import Any

from pyproj import CRS, Transformer
from pyproj.exceptions import CRSError as PyProjCRSError

logger = logging.getLogger(__name__)


class CRSConversionError(Exception):
    """Raised when CRS conversion fails."""


def parse_crs(crs_input: Any) -> CRS | None:
    """Attempt to parse a CRS from various input types.

    Accepts: pyproj CRS, rasterio CRS, string (e.g. 'EPSG:4326'),
    int (EPSG code), dict (PROJ dict), or None.

    Returns None if the input cannot be parsed as a valid CRS.
    """
    if crs_input is None:
        return None

    if isinstance(crs_input, CRS):
        return crs_input

    try:
        return CRS.from_user_input(crs_input)
    except (PyProjCRSError, TypeError, ValueError):
        logger.debug("Could not parse CRS from input: %r", crs_input)
        return None


def validate_crs(crs_input: Any) -> bool:
    """Return True if the input represents a valid CRS."""
    return parse_crs(crs_input) is not None


def crs_to_string(crs_input: Any) -> str | None:
    """Convert a CRS to a stable string representation (e.g. 'EPSG:32643').

    Returns None if the CRS cannot be parsed.
    """
    crs = parse_crs(crs_input)
    if crs is None:
        return None
    try:
        return crs.to_epsg() and f"EPSG:{crs.to_epsg()}" or crs.to_wkt()
    except Exception:
        return str(crs)


def crs_is_geographic(crs_input: Any) -> bool:
    """Check whether a CRS is geographic (lat/lon) rather than projected."""
    crs = parse_crs(crs_input)
    if crs is None:
        return False
    return crs.is_geographic


def bounds_to_wgs84(
    bounds: dict[str, float],
    src_crs: Any,
) -> dict[str, float] | None:
    """Convert raster bounds to WGS84 (EPSG:4326).

    Args:
        bounds: Dict with west, south, east, north in source CRS units.
        src_crs: The source CRS (any type parseable by parse_crs).

    Returns:
        Dict with west, south, east, north in WGS84 degrees,
        or None if conversion is not possible.
    """
    crs = parse_crs(src_crs)
    if crs is None:
        return None

    if crs.to_epsg() == 4326:
        return dict(bounds)

    try:
        transformer = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

        corners = [
            (bounds["west"], bounds["south"]),
            (bounds["east"], bounds["south"]),
            (bounds["east"], bounds["north"]),
            (bounds["west"], bounds["north"]),
        ]

        transformed = [transformer.transform(x, y) for x, y in corners]
        lons = [p[0] for p in transformed]
        lats = [p[1] for p in transformed]

        return {
            "west": min(lons),
            "south": min(lats),
            "east": max(lons),
            "north": max(lats),
        }
    except Exception as exc:
        logger.warning("CRS to WGS84 conversion failed: %s", exc)
        return None
