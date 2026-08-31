"""Unit tests for optical+SAR fusion (app/tools/fusion.py)."""

from __future__ import annotations

import pytest

from app.tools.fusion import (
    FusionValidationError,
    fusion_confidence,
    run_optical_sar_fusion,
)


def test_direct_alignment_full_overlap(fusion_paired_rasters):
    optical, sar = fusion_paired_rasters
    res = run_optical_sar_fusion(optical, sar)

    assert res["alignment"]["method"] == "direct"
    assert res["crs"]["match"] is True
    assert res["overlap"]["valid_pixels"] == 100
    assert res["overlap"]["partial"] is False
    assert res["overlap"]["valid_area_km2"] == pytest.approx(
        100 * 10 * 10 / 1_000_000.0
    )
    # NDVI of (400-100)/(400+100) = 0.6 constant over all pixels.
    assert res["optical"]["statistics"]["mean"] == pytest.approx(0.6, abs=1e-6)
    # SAR VV = 0.1 constant, speckle-filtered.
    assert res["sar"]["statistics"]["median"] == pytest.approx(0.1, abs=1e-6)
    assert res["sar"]["speckle_filter"] == "median"
    assert res["overlap"]["invalid_pixels"] == 0
    assert fusion_confidence(res) == 1.0


def test_result_is_quantitative_not_semantic(fusion_paired_rasters):
    optical, sar = fusion_paired_rasters
    res = run_optical_sar_fusion(optical, sar)
    # The result must expose numeric evidence, never a semantic conclusion.
    joined = " ".join(str(res).lower().split())
    for forbidden in ["flood", "deforestation", "landslide", "drought"]:
        assert forbidden not in joined


def test_nodata_excluded_from_overlap(fusion_nodata_pair):
    optical, sar = fusion_nodata_pair
    res = run_optical_sar_fusion(optical, sar)
    assert res["overlap"]["valid_pixels"] == 36  # 6x6 core only
    assert res["overlap"]["invalid_pixels"] == 64
    assert res["optical"]["statistics"]["count"] == 36


def test_unknown_modality_warns_but_proceeds(fusion_unknown_modality_pair):
    optical, sar = fusion_unknown_modality_pair
    res = run_optical_sar_fusion(optical, sar)
    assert res["warnings"], "expected a modality warning"
    assert any("modality" in w for w in res["warnings"])
    assert fusion_confidence(res) == 0.8


def test_diff_crs_reprojects(fusion_diff_crs_pair):
    optical, sar = fusion_diff_crs_pair
    res = run_optical_sar_fusion(optical, sar)
    assert res["alignment"]["method"] == "reprojected"
    assert res["crs"]["match"] is False
    assert res["overlap"]["valid_pixels"] > 0
    assert fusion_confidence(res) == 0.8


def test_non_overlap_fails(fusion_nonoverlap_pair):
    optical, sar = fusion_nonoverlap_pair
    with pytest.raises(FusionValidationError):
        run_optical_sar_fusion(optical, sar)


def test_missing_crs_fails(fusion_missing_crs_pair):
    optical, sar = fusion_missing_crs_pair
    with pytest.raises(FusionValidationError):
        run_optical_sar_fusion(optical, sar)


def test_explicit_optical_band_override(multiband_raster, sar_like_raster):
    # Force the optical feature to be the RED band (index 1) rather than NDVI.
    res = run_optical_sar_fusion(multiband_raster, sar_like_raster, optical_band=1)
    assert res["optical"]["feature_basis"] == "band 1"
    assert res["optical"]["statistics"]["mean"] == pytest.approx(100.0, abs=1e-6)


def test_band_out_of_range_fails(multiband_raster, sar_like_raster):
    with pytest.raises(FusionValidationError):
        run_optical_sar_fusion(multiband_raster, sar_like_raster, optical_band=99)
    with pytest.raises(FusionValidationError):
        run_optical_sar_fusion(multiband_raster, sar_like_raster, sar_band=0)
