"""Behavioural tests for georeference and raster-integrity handling.

These cover the contract that spatial values are only ever reported when they
are actually observed in the file:

* a raster is georeferenced only with a real CRS *and* a usable geotransform
* identity, degenerate and missing transforms never yield implied bounds,
  resolution or extent
* corrupt and structurally impossible rasters are classified ``invalid``
* readable non-georeferenced rasters stay usable for pixel-domain work

Every assertion here is behavioural: it checks what a caller observes, not how
the classification is implemented.
"""

from __future__ import annotations

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from app.geospatial.raster_io import (
    INTEGRITY_ANALYSIS_READY,
    INTEGRITY_INVALID,
    INTEGRITY_VISUAL_ONLY,
    NotGeoreferencedError,
    classify_raster,
    get_bounds,
    get_resolution,
    read_metadata,
)
from app.geospatial.validation import run_validation


# --------------------------------------------------------------------------
# Fixtures for the georeference matrix
# --------------------------------------------------------------------------


def _write(path, *, crs=None, transform=None, width=4, height=4, count=1, data=None):
    if data is None:
        data = np.ones((count, height, width), dtype="uint16")
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=count,
        dtype="uint16",
        crs=crs,
        transform=transform,
    ) as dst:
        dst.write(data)
    return path


@pytest.fixture
def good_georef(tmp_path):
    """CRS + real pixel size: fully analysis-ready."""
    return _write(
        tmp_path / "good.tif",
        crs="EPSG:32633",
        transform=from_origin(100.0, 40.0, 10.0, 10.0),
    )


@pytest.fixture
def no_crs_no_transform(tmp_path):
    """Neither CRS nor geotransform (rasterio substitutes the identity)."""
    return _write(tmp_path / "plain.tif")


@pytest.fixture
def crs_identity_transform(tmp_path):
    """A CRS is declared but no geotransform: the identity still means nothing."""
    return _write(tmp_path / "crs_identity.tif", crs="EPSG:32633")


@pytest.fixture
def degenerate_transform(tmp_path):
    """CRS declared, pixel size zero: footprint collapses to a single point."""
    return _write(
        tmp_path / "degenerate.tif",
        crs="EPSG:32633",
        transform=from_origin(100.0, 40.0, 0.0, 0.0),
    )


@pytest.fixture
def truncated_tiff(tmp_path):
    """A file with a valid TIFF signature but a destroyed header/body."""
    src = _write(
        tmp_path / "truncated_src.tif",
        crs="EPSG:32633",
        transform=from_origin(100.0, 40.0, 10.0, 10.0),
    )
    blob = src.read_bytes()
    path = tmp_path / "truncated.tif"
    # Keep the leading signature but destroy the IFD directory.
    path.write_bytes(blob[: len(blob) // 3] + b"\x00" * 32)
    return path


@pytest.fixture
def corrupt_png(tmp_path):
    """PNG signature followed by garbage."""
    from PIL import Image

    good = tmp_path / "good.png"
    Image.new("L", (8, 8), 12).save(good)
    blob = good.read_bytes()
    path = tmp_path / "corrupt.png"
    path.write_bytes(blob[:8] + b"\xde\xad\xbe\xef" * 16)
    return path


# --------------------------------------------------------------------------
# Metadata never fabricates spatial values
# --------------------------------------------------------------------------


def test_valid_georef_reports_real_spatial_values(good_georef):
    meta = read_metadata(good_georef)
    assert meta["is_georeferenced"] is True
    assert meta["crs"] is not None
    assert meta["bounds"] is not None
    assert meta["resolution"] == {"x": 10.0, "y": 10.0}
    # 4x4 pixels at 10 m starting at (100, 40)
    assert meta["bounds"]["west"] == pytest.approx(100.0)
    assert meta["bounds"]["north"] == pytest.approx(40.0)
    assert meta["bounds"]["east"] == pytest.approx(140.0)
    assert meta["bounds"]["south"] == pytest.approx(0.0)


@pytest.mark.parametrize(
    "fixture_name",
    ["no_crs_no_transform", "crs_identity_transform", "degenerate_transform"],
)
def test_unusable_geotransform_reports_no_spatial_values(request, fixture_name):
    """Missing, identity and degenerate transforms must all read as absent.

    Rasterio will return an identity transform, a 1-unit resolution and
    pixel-index bounds for these files. Reporting any of those would hand a
    caller coordinates that mean nothing.
    """
    path = request.getfixturevalue(fixture_name)
    meta = read_metadata(path)

    assert meta["is_georeferenced"] is False
    assert meta["bounds"] is None
    assert meta["resolution"] is None
    assert meta["transform"] is None


@pytest.mark.parametrize(
    "fixture_name",
    ["no_crs_no_transform", "crs_identity_transform", "degenerate_transform"],
)
def test_spatial_accessors_refuse_ungeoreferenced(request, fixture_name):
    """get_bounds / get_resolution raise rather than return implied values."""
    path = request.getfixturevalue(fixture_name)
    with pytest.raises(NotGeoreferencedError):
        get_bounds(path)
    with pytest.raises(NotGeoreferencedError):
        get_resolution(path)


def test_spatial_accessors_work_on_valid_georef(good_georef):
    bounds = get_bounds(good_georef)
    assert bounds["west"] == pytest.approx(100.0)
    resolution = get_resolution(good_georef)
    assert resolution == {"x": 10.0, "y": 10.0}


# --------------------------------------------------------------------------
# Integrity classification
# --------------------------------------------------------------------------


def test_classify_valid_georef_is_analysis_ready(good_georef):
    result = classify_raster(good_georef)
    assert result["integrity"] == INTEGRITY_ANALYSIS_READY
    assert result["isGeoreferenced"] is True
    assert result["reason"] is None


@pytest.mark.parametrize(
    "fixture_name", ["no_crs_no_transform", "crs_identity_transform"]
)
def test_classify_readable_ungeoreferenced_is_visual_only(request, fixture_name):
    result = classify_raster(request.getfixturevalue(fixture_name))
    assert result["integrity"] == INTEGRITY_VISUAL_ONLY
    assert result["isGeoreferenced"] is False
    # The reason must state what is and is not still possible.
    assert "Pixel-domain analysis" in result["reason"]


def test_classify_degenerate_transform_is_visual_only(degenerate_transform):
    """A CRS with a zero-area footprint is not analysis-ready.

    It is not ``invalid`` either: the raster opens and its pixels are fine, so
    visual/pixel-domain work still applies. What must never happen is it being
    treated as georeferenced, or publishing its collapsed zero-area extent.
    """
    result = classify_raster(degenerate_transform)
    assert result["integrity"] == INTEGRITY_VISUAL_ONLY
    assert result["isGeoreferenced"] is False
    assert "degenerate" in result["reason"]


def test_classify_plain_png_is_visual_only(plain_png):
    result = classify_raster(plain_png)
    assert result["integrity"] == INTEGRITY_VISUAL_ONLY
    assert result["isGeoreferenced"] is False


def test_classify_corrupt_tiff_is_invalid(corrupt_file):
    result = classify_raster(corrupt_file)
    assert result["integrity"] == INTEGRITY_INVALID
    assert result["isGeoreferenced"] is None


def test_classify_truncated_tiff_is_invalid(truncated_tiff):
    """A valid magic number must not be mistaken for a valid raster."""
    assert truncated_tiff.read_bytes()[:2] in (b"II", b"MM")
    result = classify_raster(truncated_tiff)
    assert result["integrity"] == INTEGRITY_INVALID


def test_classify_corrupt_png_is_invalid(corrupt_png):
    assert corrupt_png.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    result = classify_raster(corrupt_png)
    assert result["integrity"] == INTEGRITY_INVALID


def test_classify_missing_file_is_invalid(tmp_path):
    result = classify_raster(tmp_path / "nope.tif")
    assert result["integrity"] == INTEGRITY_INVALID
    assert result["isGeoreferenced"] is None


def test_classify_empty_file_is_invalid(empty_file):
    assert classify_raster(empty_file)["integrity"] == INTEGRITY_INVALID


# --------------------------------------------------------------------------
# Validation pipeline surfaces the same truth
# --------------------------------------------------------------------------


def test_validation_reports_analysis_ready(good_georef):
    result = run_validation(good_georef)
    assert result.is_georeferenced is True
    assert result.integrity == INTEGRITY_ANALYSIS_READY
    assert result.bounds is not None
    assert result.resolution is not None


def test_validation_reports_visual_only(no_crs_no_transform):
    """A readable non-georeferenced raster stays valid, but is flagged."""
    result = run_validation(no_crs_no_transform)
    assert result.valid is True
    assert result.is_georeferenced is False
    assert result.integrity == INTEGRITY_VISUAL_ONLY
    # No spatial values may be present for it.
    assert result.crs is None
    assert result.bounds is None
    assert result.resolution is None


def test_validation_reports_invalid_for_corrupt(corrupt_file):
    result = run_validation(corrupt_file)
    assert result.valid is False
    assert result.integrity == INTEGRITY_INVALID


def test_validation_plain_png_is_visual_only(plain_png):
    result = run_validation(plain_png)
    assert result.valid is True
    assert result.is_georeferenced is False
    assert result.integrity == INTEGRITY_VISUAL_ONLY


def test_validation_warns_that_spatial_values_are_unavailable(no_crs_no_transform):
    result = run_validation(no_crs_no_transform)
    assert any("No geospatial metadata" in w for w in result.warnings)
