"""Unit tests for bi-temporal change detection (app/tools/change.py)."""

from __future__ import annotations

import json
import math

import pytest

from app.tools.change import (
    ChangeValidationError,
    change_confidence,
    compute_change,
)


def test_identical_pair_zero_change(change_identical_pair):
    p1, p2 = change_identical_pair
    result = compute_change(p1, p2)
    assert result["changed_pixels"] == 0
    assert result["change_percentage"] == 0.0
    assert result["valid_pixels"] == 100
    assert result["alignment"] == "direct"
    assert result["warnings"] == []


def test_known_changed_pixels(change_known_pair):
    p1, p2 = change_known_pair
    result = compute_change(p1, p2, threshold=50)
    assert result["changed_pixels"] == 9
    assert result["unchanged_pixels"] == 91
    assert result["change_percentage"] == pytest.approx(9.0, abs=1e-6)
    assert result["threshold_source"] == "explicit"
    assert result["comparison_band"]["band_t1"] == 1
    assert result["comparison_band"]["band_t2"] == 1


def test_threshold_below_changes_nothing(change_known_pair):
    p1, p2 = change_known_pair
    result = compute_change(p1, p2, threshold=500)
    assert result["changed_pixels"] == 0


def test_values_above_threshold_are_changed(change_known_pair):
    """threshold=0 -> every nonzero difference is change (the 3x3 block)."""
    p1, p2 = change_known_pair
    result = compute_change(p1, p2, threshold=0)
    assert result["changed_pixels"] == 9


def test_nodata_pixels_excluded(change_nodata_pair):
    p1, p2 = change_nodata_pair
    result = compute_change(p1, p2, threshold=50)
    assert result["invalid_pixels"] == 16
    assert result["valid_pixels"] == 84
    assert result["changed_pixels"] == 4
    assert result["unchanged_pixels"] == 80


def test_nan_inf_excluded(change_nan_pair):
    p1, p2 = change_nan_pair
    result = compute_change(p1, p2, threshold=10)
    # 4 NaN + 1 Inf excluded; the single diff-49 pixel is change.
    assert result["invalid_pixels"] == 5
    assert result["valid_pixels"] == 95
    assert result["changed_pixels"] == 1
    assert result["unchanged_pixels"] == 94


def test_all_nodata_image_fails(all_nodata_raster, georeferenced_raster):
    with pytest.raises(ChangeValidationError):
        compute_change(all_nodata_raster, georeferenced_raster)


def test_missing_crs_mixed_pair_fails(change_mixed_georef_pair, ):
    p1, p2 = change_mixed_georef_pair
    with pytest.raises(ChangeValidationError):
        compute_change(p1, p2)


def test_non_georef_identical_dims_succeeds(tmp_path):
    from tests.conftest import _write_non_geo_tif
    import numpy as np
    a = np.full((6, 6), 5, dtype=np.uint8)
    b = np.full((6, 6), 5, dtype=np.uint8)
    b[1, 1] = 100
    p1 = _write_non_geo_tif(tmp_path / "ng1.tif", a)
    p2 = _write_non_geo_tif(tmp_path / "ng2.tif", b)
    result = compute_change(p1, p2, threshold=50)
    assert result["changed_pixels"] == 1
    assert result["warnings"]  # non-georeferenced warning present


def test_non_georef_different_dims_fails(change_diff_dims_pair):
    p1, p2 = change_diff_dims_pair
    with pytest.raises(ChangeValidationError):
        compute_change(p1, p2)


def test_non_overlapping_fails(change_nonoverlap_pair):
    p1, p2 = change_nonoverlap_pair
    with pytest.raises(ChangeValidationError):
        compute_change(p1, p2)


def test_different_crs_reprojects(change_diff_crs_pair):
    p1, p2 = change_diff_crs_pair
    result = compute_change(p1, p2)
    assert result["alignment"] == "reprojected"
    assert result["aligned"] is True
    assert result["valid_pixels"] > 0
    assert result["warnings"]
    assert result["change_percentage"] == pytest.approx(0.0, abs=1e-6)


def test_different_transform_reprojects(change_diff_transform_pair):
    p1, p2 = change_diff_transform_pair
    result = compute_change(p1, p2)
    assert result["alignment"] == "reprojected"
    assert result["valid_pixels"] > 0
    assert result["warnings"]


def test_invalid_band_index_fails(change_known_pair):
    p1, p2 = change_known_pair
    with pytest.raises(ChangeValidationError):
        compute_change(p1, p2, band=99)


def test_band_pair_requires_both(change_known_pair):
    p1, p2 = change_known_pair
    with pytest.raises(ChangeValidationError):
        compute_change(p1, p2, band_t1=1)


def test_confidence_is_deterministic(change_identical_pair, change_diff_crs_pair):
    p1, p2 = change_identical_pair
    r_clean = compute_change(p1, p2)
    assert change_confidence(r_clean) == 1.0

    p3, p4 = change_diff_crs_pair
    r_warn = compute_change(p3, p4)
    assert change_confidence(r_warn) == 0.8

    # Same input -> same confidence every time.
    assert change_confidence(r_clean) == change_confidence(r_clean)
    assert change_confidence(r_warn) == change_confidence(r_warn)


def test_no_nan_inf_leaks(change_nan_pair):
    p1, p2 = change_nan_pair
    result = compute_change(p1, p2, threshold=10)
    json.dumps(result)  # must not raise
    body = json.dumps(result)
    assert "NaN" not in body and "Infinity" not in body
    for v in (result["mean_difference"], result["max_difference"], result["change_percentage"]):
        assert math.isfinite(v)
