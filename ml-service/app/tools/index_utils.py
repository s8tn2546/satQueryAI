"""Shared utilities for computing standardized difference indices (NDVI/NDWI).

Both NDVI and NDWI have the form (A - B) / (A + B). This module provides a
single vectorized function and a statistics summariser that both tools reuse,
so the math and masking behave identically.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class IndexStats:
    """Summary statistics for a computed index."""
    min: float
    max: float
    mean: float
    median: float
    valid_pixel_count: int
    total_pixel_count: int


def compute_nd_index(
    band_a: np.ndarray,
    band_b: np.ndarray,
    valid_mask: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Compute (A - B) / (A + B) vectorized with division-by-zero handling.

    Args:
        band_a, band_b: float arrays of the same shape.
        valid_mask: boolean array, True where pixels are valid.

    Returns:
        (index, output_mask): the index array (invalid pixels -> NaN) and the
        boolean mask of pixels that received a valid, finite result.
    """
    a = band_a.astype(np.float64)
    b = band_b.astype(np.float64)

    numerator = a - b
    denominator = a + b

    with np.errstate(divide="ignore", invalid="ignore"):
        index = numerator / denominator

    # A pixel is valid only if it was valid input AND the denominator is non-zero.
    output_mask = valid_mask & (denominator != 0)
    # Identify masks that are in the valid-data region but had zero denominator;
    # these are genuinely undefined and must not be counted as valid.
    index = np.where(valid_mask, index, np.nan)
    index = np.where(denominator == 0, np.nan, index)

    return index, output_mask


def summarize_index(
    index: np.ndarray,
    output_mask: np.ndarray,
) -> IndexStats:
    """Compute statistics over the valid, finite index pixels only."""
    finite = output_mask & np.isfinite(index)
    total = int(index.size)

    if not np.any(finite):
        return IndexStats(
            min=0.0,
            max=0.0,
            mean=0.0,
            median=0.0,
            valid_pixel_count=0,
            total_pixel_count=total,
        )

    values = index[finite]
    return IndexStats(
        min=float(np.min(values)),
        max=float(np.max(values)),
        mean=float(np.mean(values)),
        median=float(np.median(values)),
        valid_pixel_count=int(values.size),
        total_pixel_count=total,
    )
