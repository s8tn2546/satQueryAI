"""Optical + SAR cross-modal analysis / fusion (computational remote sensing).

Purpose: given an optical image and a SAR image covering the same/similar area,
safely align them and produce **quantitative** complementary evidence — optical
features, SAR features, joint overlap statistics, and a deterministic
feature-level fusion index.

This module is explicitly NOT semantic interpretation. It does not conclude
"flood occurred" / "deforestation occurred" etc. It returns numeric evidence that
the Agent / VLM / ML layer (Member 5) may later interpret.

Missing or incompatible inputs fail with a structured error (FusionError) so the
API can return a 'failed' ToolOutput with confidence 0.0 — the module never
fabricates a fusion result.
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
    read_band,
    read_metadata,
)
from app.preprocessing.band_detection import detect_modality_from_bands
from app.preprocessing.normalize import normalize_with_nodata
from app.preprocessing.speckle_filter import median_filter
from app.tools.band_utils import (
    BandNotFoundError,
    build_valid_mask,
    resolve_band_indices,
)
from app.tools.index_utils import compute_nd_index

# Deterministic alignment resampling (optical CRS is the reference grid).
ALIGN_RESAMPLING = Resampling.nearest
# Half-pixel tolerance when comparing affine transforms.
TRANSFORM_TOL = 1e-6
# Default speckle-filter window size (odd).
SPECKLE_SIZE = 3
# Shared "meaningful overlap" sanity threshold (fraction of optical footprint).
PARTIAL_OVERLAP_TOL = 0.99


class FusionError(Exception):
    """Base exception for optical+SAR fusion errors."""


class FusionValidationError(FusionError):
    """Raised when inputs fail validation / cannot be compared."""


class FusionAlignmentError(FusionError):
    """Raised when optical and SAR cannot be safely aligned."""


class FusionComputationError(FusionError):
    """Raised when feature extraction / fusion computation fails."""


# --------------------------------------------------------------------------- #
# Geometric / CRS helpers (self-contained, mirrors change.py's safe approach) #
# --------------------------------------------------------------------------- #


def _transform_close(t1: Affine, t2: Affine) -> bool:
    return all(
        abs(a - b) <= TRANSFORM_TOL
        for a, b in ((t1.a, t2.a), (t1.b, t2.b), (t1.c, t2.c),
                     (t1.d, t2.d), (t1.e, t2.e), (t1.f, t2.f))
    )


def _crs_label(crs: Any) -> str | None:
    parsed = parse_crs(crs)
    if parsed is None:
        return None
    epsg = parsed.to_epsg()
    return f"EPSG:{epsg}" if epsg else crs_to_string(crs)


def _bounds_to_crs(bounds: dict[str, float], src: Any, dst: Any) -> dict[str, float]:
    s = parse_crs(src)
    d = parse_crs(dst)
    if s is None or d is None or s.to_epsg() == d.to_epsg():
        return dict(bounds)
    tr = Transformer.from_crs(s, d, always_xy=True)
    corners = [
        tr.transform(bounds["west"], bounds["south"]),
        tr.transform(bounds["east"], bounds["south"]),
        tr.transform(bounds["east"], bounds["north"]),
        tr.transform(bounds["west"], bounds["north"]),
    ]
    return {
        "west": min(c[0] for c in corners),
        "south": min(c[1] for c in corners),
        "east": max(c[0] for c in corners),
        "north": max(c[1] for c in corners),
    }


def _reproject_to_grid(
    src_path: Path,
    src_band: int,
    dst_transform: Affine,
    dst_crs: Any,
    dst_shape: tuple[int, int],
    src_nodata: Any,
) -> np.ndarray:
    """Reproject a SAR band onto the optical reference grid.

    Pixels outside the SAR coverage are set to NaN (excluded from statistics),
    so unrelated pixels are never compared to optical pixels.
    """
    try:
        with rasterio.open(str(src_path)) as src:
            source = src.read(src_band).astype(np.float64)
            src_transform = src.transform
            src_crs = src.crs if _crs_is_defined(src.crs) else dst_crs
    except Exception as exc:
        raise FusionAlignmentError(
            f"Could not read SAR band {src_band} for alignment: {exc}"
        ) from exc

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
        raise FusionAlignmentError(f"Reprojection/alignment failed: {exc}") from exc
    return destination


# --------------------------------------------------------------------------- #
# Modality detection                                                          #
# --------------------------------------------------------------------------- #


def _detect_modality(meta: dict[str, Any]) -> str:
    descriptions = meta.get("descriptions", [])
    return detect_modality_from_bands(descriptions, meta.get("band_count", 0))


def _verify_modality(
    optical_meta: dict[str, Any],
    sar_meta: dict[str, Any],
) -> list[str]:
    """Check the two inputs are consistent with optical and SAR roles.

    Uses band metadata only. Never guesses. Returns warnings; raises on a direct
    contradiction (e.g. the 'optical' file clearly being SAR).
    """
    warnings: list[str] = []
    opt_mod = _detect_modality(optical_meta)
    sar_mod = _detect_modality(sar_meta)

    if opt_mod == "sar":
        raise FusionValidationError(
            "The 'optical' input was identified as SAR from its band metadata. "
            "Cannot proceed with the given modality labels."
        )
    if sar_mod == "optical":
        raise FusionValidationError(
            "The 'SAR' input was identified as optical from its band metadata. "
            "Cannot proceed with the given modality labels."
        )
    if opt_mod == "unknown":
        warnings.append(
            "The optical input's modality could not be confirmed from band "
            "metadata (proceeding on the provided label)."
        )
    if sar_mod == "unknown":
        warnings.append(
            "The SAR input's modality could not be confirmed from band metadata "
            "(proceeding on the provided label)."
        )
    return warnings


# --------------------------------------------------------------------------- #
# Feature-band resolution                                                     #
# --------------------------------------------------------------------------- #


def _resolve_optical_feature(meta: dict[str, Any], explicit_band: int | None) -> tuple[str, int | None, int | None]:
    """Decide how to extract an optical feature map.

    Returns (kind, a_idx, b_idx):
      kind in {"band", "band_pair", "ndvi"}
    Precedence (never guesses band positions):
      1. explicit optical band index
      2. NDVI via labelled RED+NIR
      3. NDVI via labelled GREEN+NIR (NDWI) if RED unavailable but GREEN available
      4. first explicit labelled band
      5. single band -> band 1
      6. else -> failure
    """
    count = meta.get("band_count", 0)
    if explicit_band is not None:
        if explicit_band < 1 or explicit_band > count:
            raise FusionValidationError(
                f"Optical band index {explicit_band} out of range (1..{count})."
            )
        return "band", explicit_band, None

    descriptions = meta.get("descriptions", [])

    for required, kind in ((["red", "nir"], "ndvi"), (["green", "nir"], "ndvi")):
        try:
            res = resolve_band_indices(meta, required)
            return kind, res.indices[required[0]], res.indices[required[1]]
        except BandNotFoundError:
            continue

    # First explicit labelled band (if any).
    for i, d in enumerate(descriptions, start=1):
        if d and d.strip():
            return "band", i, None

    # Single band -> the only data available.
    if count == 1:
        return "band", 1, None

    raise FusionValidationError(
        "Cannot determine an optical feature band. Provide an explicit optical "
        "band, an image with labelled RED/NIR (or GREEN/NIR) bands, a single-band "
        "image, or at least one labelled band. The service never assumes a band's "
        "meaning from its position."
    )


def _resolve_sar_band(meta: dict[str, Any], explicit_band: int | None) -> int:
    """Choose which SAR band to analyze.

    Precedence: explicit index -> single band -> first labelled band -> failure.
    """
    count = meta.get("band_count", 0)
    if explicit_band is not None:
        if explicit_band < 1 or explicit_band > count:
            raise FusionValidationError(
                f"SAR band index {explicit_band} out of range (1..{count})."
            )
        return explicit_band

    if count == 1:
        return 1

    descriptions = meta.get("descriptions", [])
    for i, d in enumerate(descriptions, start=1):
        if d and d.strip():
            return i

    raise FusionValidationError(
        "Cannot determine which SAR band to analyze. Provide an explicit SAR "
        "band, a single-band SAR image, or a SAR image with labelled bands "
        "(e.g. VV/VH)."
    )


# --------------------------------------------------------------------------- #
# Statistics helpers                                                          #
# --------------------------------------------------------------------------- #


def _band_stats(values: np.ndarray, valid: np.ndarray) -> dict[str, float]:
    """Summary statistics over valid pixels of a 1D array of values."""
    vals = values[valid & np.isfinite(values)]
    if vals.size == 0:
        return {
            "mean": 0.0, "median": 0.0, "min": 0.0,
            "max": 0.0, "std": 0.0, "count": 0,
        }
    return {
        "mean": float(np.mean(vals)),
        "median": float(np.median(vals)),
        "min": float(np.min(vals)),
        "max": float(np.max(vals)),
        "std": float(np.std(vals)),
        "count": int(vals.size),
    }


def _is_positive_int(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0


# --------------------------------------------------------------------------- #
# Main entry point                                                            #
# --------------------------------------------------------------------------- #


def run_optical_sar_fusion(
    optical_path: str | Path,
    sar_path: str | Path,
    *,
    optical_band: int | None = None,
    sar_band: int | None = None,
    speckle_size: int | None = None,
) -> dict[str, Any]:
    """Run optical+SAR cross-modal analysis.

    Args:
        optical_path: optical raster path.
        sar_path: SAR raster path.
        optical_band: optional explicit optical band index.
        sar_band: optional explicit SAR band index.
        speckle_size: optional speckle-filter window size (odd).

    Returns:
        A dict with per-modality statistics, fusion statistics, alignment /
        overlap / nodata / normalization / speckle metadata. Raises FusionError
        subclasses for honest (non-fabricated) failures.
    """
    opath, spath = Path(optical_path), Path(sar_path)
    window = speckle_size if (speckle_size is not None and speckle_size >= 1) else SPECKLE_SIZE

    try:
        ometa = read_metadata(opath)
        smeta = read_metadata(spath)
    except Exception as exc:
        raise FusionValidationError(f"Could not read image metadata: {exc}") from exc

    warnings: list[str] = []

    # ---- 1. Basic validity ----
    for pth, meta, label in ((opath, ometa, "optical"), (spath, smeta, "SAR")):
        if meta.get("width", 0) <= 0 or meta.get("height", 0) <= 0:
            raise FusionValidationError(f"{label} image has invalid dimensions.")
        try:
            if is_raster_empty(pth):
                raise FusionValidationError(
                    f"{label} image contains only nodata/invalid pixels."
                )
        except Exception as exc:
            raise FusionValidationError(
                f"Could not verify {label} image data: {exc}"
            ) from exc

    # ---- 2. Modality ----
    warnings.extend(_verify_modality(ometa, smeta))

    # ---- 3. Georeferencing requirement ----
    if not (ometa.get("is_georeferenced") and smeta.get("is_georeferenced")):
        raise FusionValidationError(
            "Both optical and SAR images must be georeferenced (defined CRS + "
            "geotransform) for cross-modal alignment. One or both are not."
        )
    ocrs = ometa.get("crs")
    scrs = smeta.get("crs")

    # ---- 4. CRS ----
    ocrs_label = _crs_label(ocrs)
    scrs_label = _crs_label(scrs)
    crs_match = ocrs_label == scrs_label
    if not crs_match:
        warnings.append(
            "Optical and SAR use different CRSs; SAR is reprojected onto the "
            "optical grid for comparison."
        )

    # ---- 5. Spatial overlap ----
    ob = ometa["bounds"]
    sb_in_ocrs = _bounds_to_crs(smeta["bounds"], scrs, ocrs)
    opt_poly = box(ob["west"], ob["south"], ob["east"], ob["north"])
    sar_poly = box(sb_in_ocrs["west"], sb_in_ocrs["south"], sb_in_ocrs["east"], sb_in_ocrs["north"])
    intersection = opt_poly.intersection(sar_poly)
    if intersection.is_empty or intersection.area <= 0:
        raise FusionValidationError(
            "The optical and SAR images do not spatially overlap; no fusion is "
            "possible."
        )
    overlap_area_unit = float(intersection.area)
    opt_area_unit = float(opt_poly.area)
    overlap_ratio = (overlap_area_unit / opt_area_unit) if opt_area_unit > 0 else 0.0
    partial = overlap_ratio < PARTIAL_OVERLAP_TOL
    if partial:
        warnings.append(
            f"Only partial spatial overlap ({overlap_ratio:.3f} of the optical "
            "footprint) exists; only the overlapping region is analyzed."
        )

    # ---- 6. Grid alignment ----
    same_grid = (
        ometa["width"] == smeta["width"]
        and ometa["height"] == smeta["height"]
        and crs_match
        and ometa.get("transform") is not None
        and smeta.get("transform") is not None
        and _transform_close(ometa["transform"], smeta["transform"])
    )
    if same_grid:
        aligned = False
        alignment = "direct"
    else:
        aligned = True
        alignment = "reprojected"
        warnings.append("SAR is resampled onto the optical grid (deterministic).")

    # ---- 7. Optical feature ----
    opt_kind, a_idx, b_idx = _resolve_optical_feature(ometa, optical_band)
    opt_nodata = ometa.get("nodata")

    if opt_kind == "ndvi":
        red_ = read_band(opath, a_idx).astype(np.float64)
        nir_ = read_band(opath, b_idx).astype(np.float64)
        opt_valid = build_valid_mask(red_, opt_nodata) & build_valid_mask(nir_, opt_nodata)
        # compute_nd_index(a, b) = (a - b) / (a + b); NDVI needs (nir - red).
        opt_feature, _ = compute_nd_index(nir_, red_, opt_valid)
        opt_feature_basis = f"ndvi of bands {b_idx}(nir)/{a_idx}(red)"
    else:
        opt_feature = read_band(opath, a_idx).astype(np.float64)
        opt_valid = build_valid_mask(opt_feature, opt_nodata)
        opt_feature_basis = f"band {a_idx}"

    # ---- 8. SAR band + speckle ----
    sar_idx = _resolve_sar_band(smeta, sar_band)
    sar_nodata = smeta.get("nodata")

    if aligned:
        sar_raw = _reproject_to_grid(
            spath, sar_idx, ometa["transform"], ocrs,
            (ometa["height"], ometa["width"]), sar_nodata,
        )
    else:
        sar_raw = read_band(spath, sar_idx).astype(np.float64)

    sar_valid = build_valid_mask(sar_raw, sar_nodata)
    # Speckle filter then re-mask (filter produces NaN for invalid windows).
    sar_feature = median_filter(sar_raw, window, nodata=sar_nodata)
    sar_feature = np.where(sar_valid, sar_feature, np.nan)

    # ---- 9. Joint valid overlap mask ----
    valid_overlap = opt_valid & sar_valid & np.isfinite(opt_feature) & np.isfinite(sar_feature)
    joint_count = int(np.count_nonzero(valid_overlap))
    total_pixels = int(opt_feature.size)
    invalid_pixels = total_pixels - joint_count

    if joint_count == 0:
        raise FusionValidationError(
            "No valid overlapping pixels exist between the optical and SAR "
            "inputs (after nodata/NaN/Inf masking and alignment)."
        )
    if joint_count < max(4, int(total_pixels * 0.01)):
        warnings.append("The valid overlap is very small; statistics may be unstable.")

    # ---- 10. Per-modality statistics (native units) ----
    opt_stats = _band_stats(opt_feature, valid_overlap)
    sar_stats = _band_stats(sar_feature, valid_overlap)

    # ---- 11. Normalization + fusion (equal-weight feature-level baseline) ----
    opt_norm = normalize_with_nodata(opt_feature, None)
    sar_norm = normalize_with_nodata(sar_feature, None)
    # Re-guard with the joint mask (normalize can set NaN for fully-invalid axes).
    opt_norm_j = np.where(valid_overlap, opt_norm, np.nan)
    sar_norm_j = np.where(valid_overlap, sar_norm, np.nan)

    opt_norm_mean = float(np.nanmean(opt_norm_j))
    sar_norm_mean = float(np.nanmean(sar_norm_j))
    combined = 0.5 * opt_norm_j + 0.5 * sar_norm_j
    combined_mean = float(np.nanmean(combined))
    combined_std = float(np.nanstd(combined))

    corr = None
    no_opt = opt_norm_j[valid_overlap]
    no_sar = sar_norm_j[valid_overlap]
    if no_opt.shape[0] >= 2 and np.std(no_opt) > 0 and np.std(no_sar) > 0:
        corr = float(np.corrcoef(no_opt, no_sar)[0, 1])

    # ---- 12. Area (projected only) ----
    valid_area_km2 = None
    if _crs_is_defined(ocrs) and not crs_is_geographic(ocrs):
        res = ometa.get("resolution")
        if res:
            pixel_area = float(res.get("x", 0) * res.get("y", 0))
            if pixel_area > 0:
                valid_area_km2 = float(joint_count * pixel_area / 1_000_000.0)

    result = {
        "optical": {
            "feature_basis": opt_feature_basis,
            "statistics": {k: (round(v, 6) if isinstance(v, float) else v) for k, v in opt_stats.items()},
            "normalized_mean": round(opt_norm_mean, 6),
        },
        "sar": {
            "band": sar_idx,
            "statistics": {k: (round(v, 6) if isinstance(v, float) else v) for k, v in sar_stats.items()},
            "speckle_filter": "median" if window > 1 else "none",
            "speckle_window": window,
            "normalized_mean": round(sar_norm_mean, 6),
        },
        "fusion": {
            "method": "equal_weight_feature_fusion",
            "optical_weight": 0.5,
            "sar_weight": 0.5,
            "combined_mean": round(combined_mean, 6),
            "combined_std": round(combined_std, 6),
            "pearson_correlation": round(corr, 6) if corr is not None else None,
        },
        "overlap": {
            "total_pixels": total_pixels,
            "valid_pixels": joint_count,
            "invalid_pixels": invalid_pixels,
            "validation_ratio": round(joint_count / total_pixels, 6) if total_pixels else 0.0,
            "valid_area_km2": valid_area_km2,
            "partial": partial,
            "overlap_ratio": round(overlap_ratio, 6),
        },
        "alignment": {
            "method": alignment,
            "resampling": str(ALIGN_RESAMPLING),
        },
        "crs": {
            "optical": ocrs_label,
            "sar": scrs_label,
            "match": crs_match,
        },
        "resolution": ometa.get("resolution"),
        "warnings": warnings,
    }

    return result


def fusion_confidence(fusion_result: dict[str, Any]) -> float:
    """Deterministic confidence from result reliability (never random)."""
    overlap = fusion_result.get("overlap", {})
    if not overlap.get("valid_pixels"):
        return 0.0
    if fusion_result.get("warnings"):
        return 0.8
    return 1.0
