"""Tests for the validation pipeline."""

from __future__ import annotations

from app.geospatial.validation import run_validation
from app.schemas.common import ValidationStatus


def test_valid_georeferenced_raster(georeferenced_raster):
    result = run_validation(georeferenced_raster)
    assert result.valid is True
    assert result.validation_status == ValidationStatus.VALID
    assert result.width == 10
    assert result.height == 10
    assert result.band_count == 1
    assert result.crs is not None
    assert result.crs == "EPSG:32643"
    assert result.bounds is not None
    assert result.wgs84_bounds is not None
    assert result.resolution is not None
    assert result.errors == []


def test_missing_crs_warning(no_crs_raster):
    result = run_validation(no_crs_raster)
    assert result.valid is True
    assert result.validation_status == ValidationStatus.WARNING
    assert result.crs is None
    assert result.bounds is None
    assert any("No geospatial metadata" in w for w in result.warnings)


def test_corrupt_file_invalid(corrupt_file):
    result = run_validation(corrupt_file)
    assert result.valid is False
    assert result.validation_status == ValidationStatus.INVALID
    assert len(result.errors) > 0


def test_unsupported_format(tmp_path):
    bad = tmp_path / "file.txt"
    bad.write_text("hello")
    result = run_validation(bad)
    assert result.valid is False
    assert result.validation_status == ValidationStatus.INVALID
    assert any("Unsupported" in e for e in result.errors)


def test_all_nodata_raster_invalid(all_nodata_raster):
    result = run_validation(all_nodata_raster)
    assert result.valid is False
    assert result.validation_status == ValidationStatus.INVALID
    assert any("nodata" in e.lower() for e in result.errors)


def test_nodata_extracted(nodata_raster):
    result = run_validation(nodata_raster)
    assert result.nodata == -9999
    assert result.valid is True


def test_empty_file_invalid(empty_file):
    result = run_validation(empty_file)
    assert result.valid is False
    assert result.validation_status == ValidationStatus.INVALID
    assert any("empty" in e.lower() for e in result.errors)


def test_multiband_optical_detection(multiband_raster):
    result = run_validation(multiband_raster)
    assert result.modality == "optical"
    assert result.band_count == 4
    names = [b.detected_name for b in result.bands]
    assert "red" in names
    assert "nir" in names


def test_sar_modality_detection(sar_like_raster):
    result = run_validation(sar_like_raster)
    assert result.modality == "sar"


def test_single_band_unknown_modality(single_band_raster):
    result = run_validation(single_band_raster)
    assert result.modality in ("unknown", "optical")
    assert any("band descriptions" in w or "band identities" in w for w in result.warnings)


def test_modality_hint_optical(georeferenced_raster):
    result = run_validation(georeferenced_raster, modality_hint="optical")
    assert result.modality == "optical"


def test_missing_file():
    result = run_validation("/nonexistent/path/file.tif")
    assert result.valid is False
    assert result.validation_status == ValidationStatus.INVALID


def test_plain_png_is_valid_but_not_georeferenced(plain_png):
    result = run_validation(plain_png)
    assert result.valid is True
    assert result.crs is None
    assert result.bounds is None
