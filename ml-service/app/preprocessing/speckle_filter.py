"""Deterministic SAR speckle filtering (lightweight preprocessing).

SAR imagery carries inherent speckle noise. Per ML_SERVICE.md section 6.4, a
basic speckle filter should be applied before cross-modal analysis.

This module implements a simple, deterministic **median filter** using only
NumPy (a sliding-window median). It is deliberately:
  - deterministic (same input -> same output),
  - vectorized (no Python per-pixel loops),
  - dependency-light (no scipy / PyTorch / deep-learning denoiser).

Invalid pixels (nodata / NaN / Inf) are excluded from the filter window via
NaN-aware median and remain invalid in the output.
"""

from __future__ import annotations

import numpy as np


def median_filter(
    array: np.ndarray,
    size: int = 3,
    nodata=None,
) -> np.ndarray:
    """Apply a square median filter, NaN-aware, preserving invalid pixels.

    Args:
        array: 2D numeric array (SAR band).
        size: odd filter window size (e.g. 3 -> 3x3).
        nodata: optional nodata value to treat as invalid.

    Returns:
        A float64 array of the same shape. Valid pixels are replaced with the
        median of their neighbours; invalid pixels remain invalid (set to NaN).
    """
    if size < 1 or size % 2 == 0:
        raise ValueError(f"Filter size must be a positive odd integer, got {size}.")

    arr = array.astype(np.float64)
    arr = np.where(np.isfinite(arr), arr, np.nan)
    if nodata is not None:
        arr = np.where(arr == nodata, np.nan, arr)

    # NaN-aware median. Pad with a NaN border so the output keeps the input
    # shape; nanmedian ignores the NaN border at the edges.
    if size == 1:
        filtered = arr.copy()
    else:
        pad = size // 2
        padded = np.pad(arr, pad, mode="constant", constant_values=np.nan)
        windows = np.lib.stride_tricks.sliding_window_view(padded, (size, size))
        flat = windows.reshape(*windows.shape[:2], -1)
        with np.errstate(invalid="ignore"):
            filtered = np.nanmedian(flat, axis=-1)

    return filtered
