"""Tests for NDVI computation (app/tools/ndvi.py)."""

from __future__ import annotations

import pytest

from app.tools.ndvi import NdvInputError, compute_ndvi


def test_ndvi_uniform_known_value(multiband_raster):
    """red=100, nir=400 uniformly -> NDVI = (400-100)/(400+100) = 0.6."""
    result = compute_ndvi(multiband_raster)
    assert result["index"] == "NDVI"
    assert result["min"] == pytest.approx(0.6, abs=1e-6)
    assert result["max"] == pytest.approx(0.6, abs=1e-6)
    assert result["mean"] == pytest.approx(0.6, abs=1e-6)
    assert result["valid_pixel_count"] == 100
    assert result["bands"]["red"] == "Band 1"
    assert result["bands"]["nir"] == "Band 4"
    assert result["band_detection_method"] == "metadata"


def test_ndvi_with_nodata(ndvi_ndwi_raster):
    """red=200, nir=500 -> NDVI=300/700; only 36 central pixels valid."""
    result = compute_ndvi(ndvi_ndwi_raster)
    assert result["valid_pixel_count"] == 36
    assert result["total_pixel_count"] == 100
    assert result["mean"] == pytest.approx(300 / 700, abs=1e-6)
    assert result["min"] == pytest.approx(300 / 700, abs=1e-6)
    assert result["max"] == pytest.approx(300 / 700, abs=1e-6)


def test_ndvi_band_override(ndvi_ndwi_raster):
    """Explicit band overrides bypass metadata detection."""
    result = compute_ndvi(ndvi_ndwi_raster, band_overrides={"red": 1, "nir": 3})
    assert result["band_detection_method"] == "explicit_override"
    assert result["bands"]["red"] == "Band 1"
    assert result["bands"]["nir"] == "Band 3"
    assert result["mean"] == pytest.approx(300 / 700, abs=1e-6)


def test_ndvi_missing_bands_fails_honestly(unlabeled_multiband_raster):
    with pytest.raises(NdvInputError) as excinfo:
        compute_ndvi(unlabeled_multiband_raster)
    assert "could not be identified" in str(excinfo.value)


def test_ndvi_single_band_fails(single_band_raster):
    with pytest.raises(NdvInputError):
        compute_ndvi(single_band_raster)


def test_ndvi_same_band_override_fails(ndvi_ndwi_raster):
    with pytest.raises(NdvInputError) as excinfo:
        compute_ndvi(ndvi_ndwi_raster, band_overrides={"red": 1, "nir": 1})
    assert "same band index" in str(excinfo.value)


def test_ndvi_invalid_override_index(ndvi_ndwi_raster):
    with pytest.raises(NdvInputError):
        compute_ndvi(ndvi_ndwi_raster, band_overrides={"red": 0, "nir": 3})


def test_ndvi_nonexistent_file(tmp_path):
    with pytest.raises(NdvInputError):
        compute_ndvi(tmp_path / "does_not_exist.tif")
