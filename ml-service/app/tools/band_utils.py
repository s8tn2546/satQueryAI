"""Shared band-resolution and masking utilities for spectral index tools.

Both NDVI and NDWI need to locate specific bands (red, nir, green) in a
raster strictly from explicit metadata. This module provides that band
resolution plus a reusable valid-data mask builder.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from app.geospatial.raster_io import read_metadata


class BandNotFoundError(Exception):
    """Raised when a required band cannot be identified from metadata."""


@dataclass
class BandResolution:
    """Result of resolving requested bands to 1-based raster band indices."""
    indices: dict[str, int] = field(default_factory=dict)
    method: str = "metadata"
    warnings: list[str] = field(default_factory=list)


def _normalize_name(name: str) -> str:
    return name.lower().strip().replace(" ", "_").replace("[", "").replace("]", "")


# Band-name groups each requested role may map to.
BAND_ALIASES: dict[str, set[str]] = {
    "red": {"red", "b4", "band_4", "band4"},
    "nir": {"nir", "nir1", "nir_narrow", "b8", "band_8", "band8", "narrow_nir"},
    "green": {"green", "b3", "band_3", "band3"},
}


def resolve_band_indices(metadata: dict[str, Any], required: list[str]) -> BandResolution:
    """Resolve requested band roles to raster band indices from metadata.

    Only uses band descriptions explicitly present in the file. Never guesses
    a band's identity from its position.

    Raises:
        BandNotFoundError: If any required band cannot be identified.
    """
    descriptions = metadata.get("descriptions", [])
    resolution = BandResolution(method="metadata")

    # Build a lookup from normalized description -> (index) allowing duplicates.
    desc_to_indices: dict[str, list[int]] = {}
    for i, desc in enumerate(descriptions, start=1):
        normalized = _normalize_name(desc if desc else "")
        if not normalized:
            continue
        desc_to_indices.setdefault(normalized, []).append(i)

    for role in required:
        aliases = BAND_ALIASES.get(role, {role})
        found_index: int | None = None
        for alias in sorted(aliases, key=len, reverse=True):
            if alias in desc_to_indices:
                found_index = desc_to_indices[alias][0]
                break

        if found_index is None:
            raise BandNotFoundError(
                f"Required {role.upper()} band could not be identified. "
                f"Available band descriptions: {descriptions}. "
                f"The image must carry explicit band metadata (e.g. a '{role}' "
                "band name in its descriptions) for this computation."
            )
        resolution.indices[role] = found_index

    if any(not d for d in descriptions):
        resolution.warnings.append(
            "Some bands have no description; only explicitly labelled bands were used."
        )

    return resolution


def build_valid_mask(
    array: np.ndarray,
    nodata: Any = None,
) -> np.ndarray:
    """Build a boolean valid-data mask for an array.

    Returns True for valid pixels and False for invalid pixels
    (nodata values and NaN).
    """
    valid = np.ones(array.shape, dtype=bool)

    if nodata is not None:
        try:
            valid &= array != nodata
        except Exception:
            pass

    if np.issubdtype(array.dtype, np.floating):
        valid &= ~np.isnan(array)
        valid &= ~np.isinf(array)

    return valid
