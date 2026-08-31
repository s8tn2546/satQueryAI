"""NDWI (Normalized Difference Water Index) computation.

Per the project specification: NDWI = (GREEN - NIR) / (GREEN + NIR)

Requires that the GREEN and NIR band identities can be determined from
explicit band metadata. It never guesses band positions.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from app.geospatial.raster_io import read_band, read_metadata
from app.tools.band_utils import (
    BandNotFoundError,
    BandResolution,
    build_valid_mask,
    resolve_band_indices,
)
from app.tools.index_utils import IndexStats, compute_nd_index, summarize_index


class NdwiError(Exception):
    """Base exception for NDWI computation errors."""


class NdwiInputError(NdwiError):
    """Raised when the input raster cannot be used for NDWI."""


def compute_ndwi(
    path: str | Path,
    band_overrides: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Compute NDWI for a raster file.

    Args:
        path: Path to the raster file.
        band_overrides: Optional explicit 1-based band indices, e.g.
            {"green": 3, "nir": 4}.

    Returns:
        A dict with index statistics, detected bands, and metadata.
    """
    path = Path(path)
    try:
        metadata = read_metadata(path)
    except Exception as exc:
        raise NdwiInputError(f"Could not read raster metadata: {exc}") from exc

    if band_overrides:
        resolution = BandResolution(indices={
            "green": band_overrides.get("green", 0),
            "nir": band_overrides.get("nir", 0),
        }, method="explicit_override")
        if resolution.indices["green"] < 1 or resolution.indices["nir"] < 1:
            raise NdwiInputError(
                "Invalid band override: GREEN and NIR indices must be >= 1."
            )
    else:
        try:
            resolution = resolve_band_indices(metadata, ["green", "nir"])
        except BandNotFoundError as exc:
            raise NdwiInputError(str(exc)) from exc

    green_idx = resolution.indices["green"]
    nir_idx = resolution.indices["nir"]

    if green_idx == nir_idx:
        raise NdwiInputError(
            "GREEN and NIR resolved to the same band index; cannot compute NDWI."
        )

    try:
        green = read_band(path, green_idx)
        nir = read_band(path, nir_idx)
    except Exception as exc:
        raise NdwiInputError(f"Could not read required bands: {exc}") from exc

    if green.shape != nir.shape:
        raise NdwiInputError(
            f"GREEN band shape {green.shape} does not match NIR band shape {nir.shape}"
        )

    nodata = metadata.get("nodata")
    valid = build_valid_mask(green, nodata) & build_valid_mask(nir, nodata)

    if not np.any(valid):
        raise NdwiInputError(
            "All pixels are nodata/invalid; NDWI cannot be computed."
        )

    index, output_mask = compute_nd_index(green, nir, valid)
    stats = summarize_index(index, output_mask)

    warnings = list(resolution.warnings)
    if stats.valid_pixel_count == 0:
        warnings.append(
            "No valid pixels remained after division-by-zero handling."
        )

    return {
        "index": "NDWI",
        "min": stats.min,
        "max": stats.max,
        "mean": stats.mean,
        "median": stats.median,
        "valid_pixel_count": stats.valid_pixel_count,
        "total_pixel_count": stats.total_pixel_count,
        "bands": {
            "green": f"Band {green_idx}",
            "nir": f"Band {nir_idx}",
            "green_index": green_idx,
            "nir_index": nir_idx,
        },
        "band_detection_method": resolution.method,
        "warnings": warnings,
    }


def ndwi_confidence(stats: IndexStats, warnings: list[str]) -> float:
    """Return a confidence score based on NDWI result reliability."""
    if stats.valid_pixel_count == 0:
        return 0.0
    if warnings:
        return 0.8
    return 1.0
