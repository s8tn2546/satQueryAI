"""Tests for NDWI computation (app/tools/ndwi.py)."""

from __future__ import annotations

import pytest

from app.tools.ndwi import NdwiInputError, compute_ndwi


def test_ndwi_uniform_known_value(multiband_raster):
    """green=200, nir=400 uniformly -> NDWI = (200-400)/(200+400) = -1/3."""
    result = compute_ndwi(multiband_raster)
    assert result["index"] == "NDWI"
    assert result["min"] == pytest.approx(-1 / 3, abs=1e-6)
    assert result["max"] == pytest.approx(-1 / 3, abs=1e-6)
    assert result["mean"] == pytest.approx(-1 / 3, abs=1e-6)
    assert result["valid_pixel_count"] == 100
    assert result["bands"]["green"] == "Band 2"
    assert result["bands"]["nir"] == "Band 4"
    assert result["band_detection_method"] == "metadata"


def test_ndwi_with_nodata(ndvi_ndwi_raster):
    """green=260, nir=500 -> NDWI=(260-500)/760; 36 central pixels valid."""
    result = compute_ndwi(ndvi_ndwi_raster)
    assert result["valid_pixel_count"] == 36
    assert result["mean"] == pytest.approx(-240 / 760, abs=1e-6)


def test_ndwi_band_override(ndvi_ndwi_raster):
    result = compute_ndwi(ndvi_ndwi_raster, band_overrides={"green": 2, "nir": 3})
    assert result["band_detection_method"] == "explicit_override"
    assert result["bands"]["green"] == "Band 2"
    assert result["bands"]["nir"] == "Band 3"
    assert result["mean"] == pytest.approx(-240 / 760, abs=1e-6)


def test_ndwi_missing_bands_fails_honestly(unlabeled_multiband_raster):
    with pytest.raises(NdwiInputError) as excinfo:
        compute_ndwi(unlabeled_multiband_raster)
    assert "could not be identified" in str(excinfo.value)


def test_ndwi_single_band_fails(single_band_raster):
    with pytest.raises(NdwiInputError):
        compute_ndwi(single_band_raster)


def test_ndwi_same_band_override_fails(ndvi_ndwi_raster):
    with pytest.raises(NdwiInputError) as excinfo:
        compute_ndwi(ndvi_ndwi_raster, band_overrides={"green": 3, "nir": 3})
    assert "same band index" in str(excinfo.value)
