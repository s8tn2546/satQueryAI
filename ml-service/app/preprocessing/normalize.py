"""Numeric normalization utilities for preprocessing.

Provides small, reusable functions for normalizing NumPy arrays.
Only used for preprocessing infrastructure — no ML model preprocessing here.
"""

from __future__ import annotations

import numpy as np


def normalize_to_float(
    array: np.ndarray,
    dtype: np.dtype = np.float32,
) -> np.ndarray:
    """Normalize an integer array to [0, 1] float range.

    Handles uint8, uint16, uint32, int16, int32, and float inputs.
    Preserves original data by returning a copy.
    """
    arr = array.astype(np.float64)

    if np.issubdtype(array.dtype, np.floating):
        return arr.astype(dtype)

    info = np.iinfo(array.dtype)
    if info.max == 0:
        return np.zeros_like(arr, dtype=dtype)

    normalized = (arr - info.min) / (info.max - info.min)
    return normalized.astype(dtype)


def normalize_with_nodata(
    array: np.ndarray,
    nodata: float | int | None = None,
    dtype: np.dtype = np.float32,
) -> np.ndarray:
    """Normalize an array to [0, 1] while masking nodata values.

    Nodata pixels are set to NaN in the output.
    """
    arr = array.astype(np.float64)

    mask = np.zeros(arr.shape, dtype=bool)
    if nodata is not None:
        mask = arr == nodata

    if np.issubdtype(array.dtype, np.floating):
        mask |= np.isnan(arr)

    if np.issubdtype(array.dtype, np.integer):
        info = np.iinfo(array.dtype)
        if info.max == 0:
            return np.zeros_like(arr, dtype=dtype)
        valid = arr[~mask]
        if valid.size == 0:
            result = np.full(arr.shape, np.nan, dtype=np.float64)
            return result.astype(dtype)
        vmin, vmax = float(valid.min()), float(valid.max())
        if vmax == vmin:
            result = np.full(arr.shape, 0.5, dtype=np.float64)
        else:
            result = (arr - vmin) / (vmax - vmin)
    else:
        valid = arr[~mask]
        if valid.size == 0:
            result = np.full(arr.shape, np.nan, dtype=np.float64)
            return result.astype(dtype)
        vmin, vmax = float(valid.min()), float(valid.max())
        if vmax == vmin:
            result = np.full(arr.shape, 0.5, dtype=np.float64)
        else:
            result = (arr - vmin) / (vmax - vmin)

    result[mask] = np.nan
    return result.astype(dtype)


def safe_divide(
    numerator: np.ndarray,
    denominator: np.ndarray,
    fill: float = 0.0,
) -> np.ndarray:
    """Divide two arrays, handling division by zero.

    Pixels where denominator is zero are set to `fill`.
    Returns float64.
    """
    num = numerator.astype(np.float64)
    den = denominator.astype(np.float64)

    with np.errstate(divide="ignore", invalid="ignore"):
        result = np.where(den != 0, num / den, fill)

    return result.astype(np.float64)


def clip_array(
    array: np.ndarray,
    low: float = 0.0,
    high: float = 1.0,
) -> np.ndarray:
    """Clip array values to [low, high] range. Returns a copy."""
    return np.clip(array, low, high)
