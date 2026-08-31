"""Bi-temporal change detection between two raster images.

Conceptual pipeline:
    two images -> validate each -> check compatibility (CRS / dimensions /
    bounds / resolution) -> co-register / align if safely possible ->
    pick a comparison band -> normalize -> absolute pixel difference ->
    change mask (difference > threshold) -> change statistics -> evidence.

The implementation never fabricates a change result. If the two images cannot
be reliably compared (incompatible CRS, no spatial overlap, mixed georeference,
no valid pixels, or an undeterminable comparison band), it raises a structured
error which the API surfaces as a 'failed' ToolOutput with confidence 0.0.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject
from shapely.geometry import box

from app.geospatial.crs import crs_is_geographic, crs_to_string, parse_crs
from app.geospatial.raster_io import (
    _crs_is_defined,
    is_raster_empty,
    read_metadata,
)
from app.tools.band_utils import build_valid_mask

# Resampling for the (rare) reprojection path. NEAREST is chosen deliberately:
# it never averages across nodata boundaries and never invents new values.
ALIGN_RESAMPLING = Resampling.nearest

# A generous tolerance when comparing affine transforms (pixel origins and
# scales) so tiny floating-point differences do not force an unnecessary, and
# possibly lossy, reprojection.
TRANSFORM_TOL = 1e-6


class ChangeError(Exception):
    """Base exception for change-detection errors."""


class ChangeValidationError(ChangeError):
    """Raised when the input pair cannot satisfy change-detection requirements."""


class ChangeAlignmentError(ChangeError):
    """Raised when the two images cannot be aligned/co-registered safely."""


class ChangeComputationError(ChangeError):
    """Raised when the difference computation fails."""


def _normalize_band_name(name: str) -> str:
    return (name or "").lower().strip().replace(" ", "_")


def _transforms_close(t1: Affine, t2: Affine) -> bool:
    """Return True if two affine transforms agree within tolerance."""
    return (
        abs(t1.a - t2.a) <= TRANSFORM_TOL
        and abs(t1.b - t2.b) <= TRANSFORM_TOL
        and abs(t1.c - t2.c) <= TRANSFORM_TOL
        and abs(t1.d - t2.d) <= TRANSFORM_TOL
        and abs(t1.e - t2.e) <= TRANSFORM_TOL
        and abs(t1.f - t2.f) <= TRANSFORM_TOL
    )


def _crs_epsg(crs: Any) -> str | None:
    parsed = parse_crs(crs)
    if parsed is None:
        return None
    epsg = parsed.to_epsg()
    return f"EPSG:{epsg}" if epsg else (crs_to_string(crs) or "defined")


def _bounds_to_crs(bounds: dict[str, float], src_crs: Any, dst_crs: Any) -> dict[str, float]:
    """Reproject raster bounds (west/south/east/north) into dst_crs."""
    src = parse_crs(src_crs)
    dst = parse_crs(dst_crs)
    if src is None or dst is None or src.to_epsg() == dst.to_epsg():
        return dict(bounds)
    transformer = Transformer.from_crs(src, dst, always_xy=True)
    corners = [
        transformer.transform(bounds["west"], bounds["south"]),
        transformer.transform(bounds["east"], bounds["south"]),
        transformer.transform(bounds["east"], bounds["north"]),
        transformer.transform(bounds["west"], bounds["north"]),
    ]
    return {
        "west": min(c[0] for c in corners),
        "south": min(c[1] for c in corners),
        "east": max(c[0] for c in corners),
        "north": max(c[1] for c in corners),
    }


def _resolve_comparison_band(
    meta1: dict[str, Any],
    meta2: dict[str, Any],
    band: int | None,
    band_t1: int | None,
    band_t2: int | None,
) -> tuple[int, int, str]:
    """Determine which band to compare in each image.

    Priority (documented, never guesses by position):
      1. explicit shared `band` index
      2. explicit `band_t1` + `band_t2` pair
      3. both images are single-band -> compare band 1 (the only data)
      4. a band name present in *both* images' explicit descriptions
      5. otherwise -> failure (cannot pick a comparison band honestly)
    """
    count1 = meta1.get("band_count", 0)
    count2 = meta2.get("band_count", 0)

    def check(idx: int, count: int, label: str) -> int:
        if idx < 1 or idx > count:
            raise ChangeValidationError(
                f"{label} band index {idx} out of range (1..{count})."
            )
        return idx

    if band is not None:
        check(band, count1, "image1")
        check(band, count2, "image2")
        return band, band, f"explicit band {band}"

    if band_t1 is not None or band_t2 is not None:
        if band_t1 is None or band_t2 is None:
            raise ChangeValidationError(
                "Provide both band_t1 and band_t2 (they must be specified together)."
            )
        check(band_t1, count1, "image1")
        check(band_t2, count2, "image2")
        return band_t1, band_t2, f"explicit pair {band_t1}/{band_t2}"

    # Both single-band: compare the only band present (a data comparison, not a
    # spectral assumption).
    if count1 == 1 and count2 == 1:
        return 1, 1, "single-band (band 1 both images)"

    # Common explicitly-labelled band.
    d1 = {_normalize_band_name(d): i for i, d in enumerate(meta1.get("descriptions", []), start=1)}
    d2 = {_normalize_band_name(d): i for i, d in enumerate(meta2.get("descriptions", []), start=1)}
    common = [name for name in d1 if name and name in d2]
    if common:
        name = common[0]
        return d1[name], d2[name], f"common labelled band '{name}'"

    raise ChangeValidationError(
        "Cannot determine which band(s) to compare. Supply an explicit band or "
        "band_t1/band_t2, use two single-band images, or provide images with "
        "common labelled bands (descriptions). The service never assumes a "
        "band's meaning from its position."
    )


def _read_band_float(path: Path, band_index: int) -> np.ndarray:
    with rasterio.open(str(path)) as src:
        return src.read(band_index).astype(np.float64)


def _reproject_band_to_grid(
    src_path: Path,
    src_band: int,
    dst_transform: Affine,
    dst_crs: Any,
    dst_shape: tuple[int, int],
    src_nodata: Any,
) -> np.ndarray:
    """Reproject a single band from src_path onto a target grid.

    Pixels outside the source coverage are set to NaN and later excluded from
    statistics, so partial/non-overlap never becomes fake change.
    """
    try:
        with rasterio.open(str(src_path)) as src:
            source = src.read(src_band).astype(np.float64)
            src_transform = src.transform
            src_crs = src.crs
            if src_crs is None:
                src_crs = dst_crs
    except Exception as exc:
        raise ChangeAlignmentError(f"Could not read band {src_band} for alignment: {exc}") from exc

    dst_h, dst_w = dst_shape
    destination = np.zeros((dst_h, dst_w), dtype=np.float64)
    try:
        reproject(
            source=source,
            destination=destination,
            src_transform=src_transform,
            src_crs=src_crs,
            dst_transform=dst_transform,
            dst_crs=dst_crs,
            src_nodata=src_nodata,
            dst_nodata=np.nan,
            resampling=ALIGN_RESAMPLING,
        )
    except Exception as exc:
        raise ChangeAlignmentError(f"Reprojection/alignment failed: {exc}") from exc
    return destination


def _overlap_supported(meta1: dict[str, Any], meta2: dict[str, Any]) -> bool:
    """Whether geospatial overlap can be established between the two images."""
    if not (meta1.get("is_georeferenced") and meta2.get("is_georeferenced")):
        return True  # handled by the caller's lighter non-georeferenced path
    b1 = meta1.get("bounds")
    b2 = meta2.get("bounds")
    if not b1 or not b2:
        return False
    return True


def _compute_difference_stats(
    band1: np.ndarray,
    band2: np.ndarray,
    nodata1: Any,
    nodata2: Any,
    threshold: float | None,
) -> dict[str, Any]:
    """Core differencing, masking, and thresholding. Never runs per-pixel loops."""
    if band1.shape != band2.shape:
        raise ChangeAlignmentError(
            f"Aligned band shapes differ ({band1.shape} vs {band2.shape}); "
            "cannot compare pixel-wise."
        )

    valid = build_valid_mask(band1, nodata1) & build_valid_mask(band2, nodata2)

    with np.errstate(invalid="ignore"):
        diff = np.abs(band1 - band2)
    diff = np.where(valid & np.isfinite(diff), diff, np.nan)

    valid_values = diff[valid & np.isfinite(diff)]
    valid_count = int(valid_values.size)
    total_pixels = int(band1.size)

    if valid_count == 0:
        raise ChangeComputationError(
            "No valid (non-nodata, finite) overlapping pixels exist to compare. "
            "The pair cannot be compared."
        )

    mean_diff = float(np.mean(valid_values))
    max_diff = float(np.max(valid_values))
    std_diff = float(np.std(valid_values))

    if threshold is None:
        # Documented deterministic default: two standard deviations of the valid
        # pixel differences, a standard statistical change-detection baseline.
        threshold = 2.0 * std_diff
        threshold_source = "auto_2sigma"
    else:
        threshold_source = "explicit"

    changed_mask = (diff > threshold) & valid
    changed_pixels = int(np.count_nonzero(changed_mask))
    unchanged_pixels = valid_count - changed_pixels
    invalid_pixels = total_pixels - valid_count
    change_percentage = (changed_pixels / valid_count * 100.0) if valid_count else 0.0

    return {
        "total_pixels": total_pixels,
        "valid_pixels": valid_count,
        "invalid_pixels": invalid_pixels,
        "changed_pixels": changed_pixels,
        "unchanged_pixels": unchanged_pixels,
        "change_percentage": change_percentage,
        "mean_difference": mean_diff,
        "max_difference": max_diff,
        "threshold": float(threshold),
        "threshold_source": threshold_source,
    }


def _changed_area_km2(meta1: dict[str, Any], changed_pixels: int) -> float | None:
    """Area of changed pixels in km², or None when not computable.

    Only valid for a defined, projected (non-geographic) CRS with resolution in
    meters. Never computes deg*deg.
    """
    crs = meta1.get("crs")
    res = meta1.get("resolution")
    if not _crs_is_defined(crs) or crs_is_geographic(crs) or not res:
        return None
    if changed_pixels <= 0:
        return 0.0
    pixel_area = float(res.get("x", 0) * res.get("y", 0))
    if pixel_area <= 0:
        return None
    return float(changed_pixels * pixel_area / 1_000_000.0)


def compute_change(
    path1: str | Path,
    path2: str | Path,
    *,
    threshold: float | None = None,
    band: int | None = None,
    band_t1: int | None = None,
    band_t2: int | None = None,
) -> dict[str, Any]:
    """Run bi-temporal change detection between two raster images.

    Args:
        path1, path2: paths to the two input rasters (image1 = time 1).
        threshold: optional change threshold in data units. If None, the
            deterministic 2-sigma default is used.
        band / band_t1 / band_t2: optional band selection (see
            _resolve_comparison_band).

    Returns:
        A dict with change statistics and metadata. May raise ChangeError
        subclasses for honest, unavoidable failures.
    """
    p1, p2 = Path(path1), Path(path2)

    try:
        meta1 = read_metadata(p1)
        meta2 = read_metadata(p2)
    except Exception as exc:
        raise ChangeValidationError(f"Could not read image metadata: {exc}") from exc

    warnings: list[str] = []

    # ---- 1. Per-image basic validity ----
    for pth, meta, label in ((p1, meta1, "image1"), (p2, meta2, "image2")):
        if meta.get("width", 0) <= 0 or meta.get("height", 0) <= 0:
            raise ChangeValidationError(f"{label} has invalid dimensions.")
        try:
            if is_raster_empty(pth):
                raise ChangeValidationError(
                    f"{label} contains only nodata/invalid pixels; it has no usable data."
                )
        except Exception as exc:
            raise ChangeValidationError(f"Could not verify {label} data: {exc}") from exc

    # ---- 2. Georeference compatibility ----
    georef1 = meta1.get("is_georeferenced", False)
    georef2 = meta2.get("is_georeferenced", False)
    crs1 = meta1.get("crs") if georef1 else None
    crs2 = meta2.get("crs") if georef2 else None

    if georef1 != georef2:
        raise ChangeValidationError(
            "Images have inconsistent georeferencing (one has a CRS/geotransform, "
            "the other does not). A reliable comparison is not possible."
        )

    both_georeferenced = georef1 and georef2
    if not both_georeferenced:
        # Lighter path for non-georeferenced inputs (e.g. benchmark pairs):
        # pixel-wise comparison only if dimensions match exactly.
        if meta1.get("width") != meta2.get("width") or meta1.get("height") != meta2.get("height"):
            raise ChangeValidationError(
                f"Non-georeferenced images have mismatched dimensions "
                f"({meta1['width']}x{meta1['height']} vs "
                f"{meta2['width']}x{meta2['height']}); cannot compare."
            )
        warnings.append(
            "Images are not georeferenced; comparison is pixel-wise only and "
            "no geospatial overlap/alignment could be verified."
        )

    # ---- 3. CRS / spatial compatibility and alignment ----
    aligned = False
    alignment = "direct"
    transform1 = meta1.get("transform")
    transform2 = meta2.get("transform")

    if both_georeferenced:
        if _crs_epsg(crs1) != _crs_epsg(crs2):
            warnings.append(
                "Images use different CRSs; image2 will be reprojected onto "
                "image1's grid for comparison."
            )

        # Overlap check (transform image2 bounds into image1's CRS).
        b2_in_crs1 = _bounds_to_crs(meta2["bounds"], crs2, crs1)
        b1 = meta1["bounds"]
        poly1 = box(b1["west"], b1["south"], b1["east"], b1["north"])
        poly2 = box(b2_in_crs1["west"], b2_in_crs1["south"], b2_in_crs1["east"], b2_in_crs1["north"])
        if poly1.intersection(poly2).area <= 0:
            raise ChangeValidationError(
                "The two images do not spatially overlap; no meaningful comparison "
                "is possible."
            )

        same_grid = (
            meta1["width"] == meta2["width"]
            and meta1["height"] == meta2["height"]
            and transform1 is not None
            and transform2 is not None
            and _transforms_close(transform1, transform2)
        )
        if same_grid:
            alignment = "direct"
        else:
            warnings.append(
                "Images do not share an identical pixel grid; image2 is aligned "
                "onto image1's grid."
            )
            alignment = "reprojected"
            aligned = True
    else:
        # Non-georeferenced: no alignment transform required.
        alignment = "direct"

    # ---- 4. Band selection ----
    band1_idx, band2_idx, band_desc = _resolve_comparison_band(
        meta1, meta2, band, band_t1, band_t2
    )

    # ---- 5. Read & align the comparison bands ----
    nodata1 = meta1.get("nodata")
    nodata2 = meta2.get("nodata")

    if aligned and both_georeferenced:
        band1 = _read_band_float(p1, band1_idx)
        band2 = _reproject_band_to_grid(
            p2,
            band2_idx,
            transform1,
            crs1,
            band1.shape,
            nodata2,
        )
    else:
        band1 = _read_band_float(p1, band1_idx)
        band2 = _read_band_float(p2, band2_idx)

    # ---- 6. Difference, threshold, stats ----
    try:
        stats = _compute_difference_stats(
            band1, band2, nodata1, nodata2, threshold
        )
    except ChangeComputationError as exc:
        raise ChangeValidationError(str(exc)) from exc

    changed_area_km2 = _changed_area_km2(meta1, stats["changed_pixels"])

    overlap = None
    wgs84_overlap = None
    if both_georeferenced:
        overlap = {
            "west": max(b1["west"], b2_in_crs1["west"]),
            "south": max(b1["south"], b2_in_crs1["south"]),
            "east": min(b1["east"], b2_in_crs1["east"]),
            "north": min(b1["north"], b2_in_crs1["north"]),
        }
        if overlap["east"] <= overlap["west"] or overlap["north"] <= overlap["south"]:
            overlap = None

    result = {
        "method": "absolute_difference",
        "comparison_band": {
            "band_t1": band1_idx,
            "band_t2": band2_idx,
            "basis": band_desc,
        },
        "threshold": stats["threshold"],
        "threshold_source": stats["threshold_source"],
        "total_pixels": stats["total_pixels"],
        "valid_pixels": stats["valid_pixels"],
        "invalid_pixels": stats["invalid_pixels"],
        "changed_pixels": stats["changed_pixels"],
        "unchanged_pixels": stats["unchanged_pixels"],
        "change_percentage": round(stats["change_percentage"], 6),
        "mean_difference": round(stats["mean_difference"], 6),
        "max_difference": round(stats["max_difference"], 6),
        "changed_area_km2": changed_area_km2,
        "aligned": aligned,
        "alignment": alignment,
        "warnings": warnings,
    }

    if warnings:
        result["warnings"] = warnings

    return result


def change_confidence(change_result: dict[str, Any]) -> float:
    """Deterministic confidence from change-result reliability (never random).

    1.0: direct comparison, no warnings, valid pixels present.
    0.8: reprojection/alignment or other warnings present, but valid pixels exist.
    0.0: failure (no valid pixels / error only).
    """
    if change_result.get("valid_pixels", 0) == 0:
        return 0.0
    if change_result.get("warnings"):
        return 0.8
    return 1.0
