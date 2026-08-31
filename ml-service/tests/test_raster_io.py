"""Tests for geospatial raster I/O."""

from __future__ import annotations

import numpy as np
import pytest

from app.geospatial.raster_io import (
    RasterCorruptError,
    RasterFormatError,
    RasterNotFoundError,
    get_band_count,
    get_bounds,
    get_crs,
    get_nodata,
    get_resolution,
    is_raster_empty,
    open_raster,
    read_band,
    read_metadata,
)


def test_open_valid_raster(georeferenced_raster):
    with open_raster(georeferenced_raster) as src:
        assert src.width == 10
        assert src.height == 10
        assert src.count == 1


def test_open_missing_file_raises(tmp_path):
    missing = tmp_path / "nope.tif"
    with pytest.raises(RasterNotFoundError):
        with open_raster(missing):
            pass


def test_open_unsupported_extension_raises(tmp_path):
    bad = tmp_path / "file.txt"
    bad.write_text("hello")
    with pytest.raises(RasterFormatError):
        with open_raster(bad):
            pass


def test_open_corrupt_file_raises(corrupt_file):
    with pytest.raises((RasterFormatError, RasterCorruptError)):
        with open_raster(corrupt_file):
            pass


def test_read_metadata(georeferenced_raster):
    meta = read_metadata(georeferenced_raster)
    assert meta["width"] == 10
    assert meta["height"] == 10
    assert meta["band_count"] == 1
    assert meta["dtype"] == "uint8"
    assert meta["is_georeferenced"] is True
    assert meta["bounds"]["west"] < meta["bounds"]["east"]
    assert meta["bounds"]["south"] < meta["bounds"]["north"]
    assert meta["resolution"]["x"] == 10
    assert meta["resolution"]["y"] == 10


def test_read_metadata_no_crs(no_crs_raster):
    meta = read_metadata(no_crs_raster)
    assert meta["is_georeferenced"] is False


def test_read_band(georeferenced_raster):
    band = read_band(georeferenced_raster, 1)
    assert band.shape == (10, 10)
    assert band.dtype == np.uint8


def test_read_band_out_of_range(georeferenced_raster):
    with pytest.raises(ValueError):
        read_band(georeferenced_raster, 99)


def test_get_bounds(georeferenced_raster):
    bounds = get_bounds(georeferenced_raster)
    assert set(bounds.keys()) == {"west", "south", "east", "north"}
    assert bounds["east"] > bounds["west"]


def test_get_resolution(georeferenced_raster):
    res = get_resolution(georeferenced_raster)
    assert res["x"] == 10
    assert res["y"] == 10


def test_get_crs(georeferenced_raster):
    crs = get_crs(georeferenced_raster)
    assert crs is not None
    assert crs.to_epsg() == 32643


def test_get_crs_none(no_crs_raster):
    assert get_crs(no_crs_raster) is None


def test_get_band_count(georeferenced_raster):
    assert get_band_count(georeferenced_raster) == 1


def test_get_nodata(nodata_raster):
    assert get_nodata(nodata_raster) == -9999


def test_get_nodata_none(georeferenced_raster):
    assert get_nodata(georeferenced_raster) is None


def test_is_raster_empty(all_nodata_raster):
    assert is_raster_empty(all_nodata_raster) is True


def test_is_raster_not_empty(nodata_raster):
    assert is_raster_empty(nodata_raster) is False
