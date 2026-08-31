"""Tests for area computation (app/tools/area.py)."""

from __future__ import annotations

import pytest

from app.tools.area import AreaInputError, compute_area


def test_area_projected_with_nodata(nodata_raster):
    """EPSG:32643, 10m pixels, 36 valid pixels -> 36 * 100 = 3600 m²."""
    result = compute_area(nodata_raster, feature_type="water")
    assert result["status"] == "success"
    assert result["feature_type"] == "water"
    assert result["valid_pixel_count"] == 36
    assert result["area_m2"] == pytest.approx(3600.0, abs=0.01)
    assert result["area_km2"] == pytest.approx(0.0036, abs=1e-6)
    assert result["area_ha"] == pytest.approx(0.36, abs=1e-4)
    assert result["pixel_area_m2"] == pytest.approx(100.0, abs=1e-6)
    assert result["crs"] == "EPSG:32643"
    assert result["confidence"] == 1.0


def test_area_all_valid_pixels(georeferenced_raster):
    """100 valid pixels, 10m resolution -> 100 * 100 = 10000 m²."""
    result = compute_area(georeferenced_raster)
    assert result["status"] == "success"
    assert result["valid_pixel_count"] == 100
    assert result["area_m2"] == pytest.approx(10000.0, abs=0.01)


def test_area_geographic_crs_fails_honestly(geographic_raster):
    """EPSG:4326 must NOT be computed as deg*deg -> structured failure."""
    result = compute_area(geographic_raster)
    assert result["status"] == "failure"
    assert result["area_km2"] is None
    assert "geographic" in result["reason"].lower()


def test_area_no_resolution_fails(no_crs_raster):
    """No transform/CRS -> no resolution available -> error."""
    with pytest.raises(AreaInputError) as excinfo:
        compute_area(no_crs_raster)
    assert "resolution" in str(excinfo.value).lower()


def test_area_all_nodata_fails(all_nodata_raster):
    with pytest.raises(AreaInputError):
        compute_area(all_nodata_raster)


def test_area_nonexistent_file(tmp_path):
    with pytest.raises(AreaInputError):
        compute_area(tmp_path / "missing.tif")
