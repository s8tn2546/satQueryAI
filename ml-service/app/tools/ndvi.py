"""NDVI (Normalized Difference Vegetation Index) computation.

NDVI = (NIR - RED) / (NIR + RED)

Requires that the RED and NIR band identities can be determined from explicit
band metadata. It never guesses band positions.
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


class NdvError(Exception):
    """Base exception for NDVI computation errors."""


class NdvInputError(NdvError):
    """Raised when the input raster cannot be used for NDVI."""


def compute_ndvi(
    path: str | Path,
    band_overrides: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Compute NDVI for a raster file.

    Args:
        path: Path to the raster file.
        band_overrides: Optional explicit 1-based band indices for the roles,
            e.g. {"red": 3, "nir": 4}. Overrides metadata detection but is
            optional.

    Returns:
        A dict with index statistics, detected bands, and metadata.
    """
    path = Path(path)
    try:
        metadata = read_metadata(path)
    except Exception as exc:
        raise NdvInputError(f"Could not read raster metadata: {exc}") from exc

    if band_overrides:
        resolution = BandResolution(indices={
            "red": band_overrides.get("red", 0),
            "nir": band_overrides.get("nir", 0),
        }, method="explicit_override")
        if resolution.indices["red"] < 1 or resolution.indices["nir"] < 1:
            raise NdvInputError(
                "Invalid band override: RED and NIR indices must be >= 1."
            )
    else:
        try:
            resolution = resolve_band_indices(metadata, ["red", "nir"])
        except BandNotFoundError as exc:
            raise NdvInputError(str(exc)) from exc

    red_idx = resolution.indices["red"]
    nir_idx = resolution.indices["nir"]

    if red_idx == nir_idx:
        raise NdvInputError(
            "RED and NIR resolved to the same band index; cannot compute NDVI."
        )

    try:
        red = read_band(path, red_idx)
        nir = read_band(path, nir_idx)
    except Exception as exc:
        raise NdvInputError(f"Could not read required bands: {exc}") from exc

    if red.shape != nir.shape:
        raise NdvInputError(
            f"RED band shape {red.shape} does not match NIR band shape {nir.shape}"
        )

    nodata = metadata.get("nodata")
    valid = build_valid_mask(red, nodata) & build_valid_mask(nir, nodata)

    if not np.any(valid):
        raise NdvInputError(
            "All pixels are nodata/invalid; NDVI cannot be computed."
        )

    index, output_mask = compute_nd_index(nir, red, valid)
    stats = summarize_index(index, output_mask)

    warnings = list(resolution.warnings)
    if stats.valid_pixel_count == 0:
        warnings.append(
            "No valid pixels remained after division-by-zero handling."
        )

    return {
        "index": "NDVI",
        "min": stats.min,
        "max": stats.max,
        "mean": stats.mean,
        "median": stats.median,
        "valid_pixel_count": stats.valid_pixel_count,
        "total_pixel_count": stats.total_pixel_count,
        "bands": {
            "red": f"Band {red_idx}",
            "nir": f"Band {nir_idx}",
            "red_index": red_idx,
            "nir_index": nir_idx,
        },
        "band_detection_method": resolution.method,
        "warnings": warnings,
    }


def ndvi_confidence(stats: IndexStats, warnings: list[str]) -> float:
    """Return a confidence score based on NDVI result reliability.

    1.0 when bands came from explicit metadata with no warnings and valid
    pixels exist; 0.8 if there are minor warnings; 0.0 otherwise.
    """
    if stats.valid_pixel_count == 0:
        return 0.0
    if warnings:
        return 0.8
    return 1.0
