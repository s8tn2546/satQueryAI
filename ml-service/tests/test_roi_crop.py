"""Tests for the shared AOI crop/mask layer (app.tools.roi_crop).

Covers AOI parsing/validation, CRS resolution and transformation, real
rasterio spatial cropping, nodata preservation, derived-raster integrity and
the non-georeferenced failure path.
"""

from __future__ import annotations

import json

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

from app.tools.roi_crop import (
    GEOJSON_DEFAULT_CRS,
    GEOJSON_DEFAULT_CRS_SOURCE,
    SCOPE_MASKED,
    SCOPE_WINDOW,
    STATUS_APPLIED,
    STATUS_NOT_GEOREFERENCED,
    STATUS_NOT_REQUESTED,
    STATUS_REJECTED_CRS,
    STATUS_REJECTED_GEOMETRY,
    STATUS_REJECTED_OUTSIDE,
    STATUS_VALIDATED,
    AoiCrsError,
    AoiGeoreferenceError,
    AoiOutsideRasterError,
    AoiValidationError,
    crop_raster,
    has_aoi,
    no_aoi_scope,
    parse_aoi,
    validate_aoi_only,
)
from app.tools.roi_crop import aoi_scope as aoi_scope_cm


# --------------------------------------------------------------------------- #
# has_aoi                                                                     #
# --------------------------------------------------------------------------- #


class TestHasAoi:
    @pytest.mark.parametrize("value", [None, "", "   ", {}, b""])
    def test_absent(self, value):
        assert has_aoi(value) is False

    @pytest.mark.parametrize("value", [{"type": "Polygon"}, '{"type":"Polygon"}', [1, 2]])
    def test_present(self, value):
        assert has_aoi(value) is True


# --------------------------------------------------------------------------- #
# parse_aoi: accepted forms                                                    #
# --------------------------------------------------------------------------- #


class TestParseAoiAccepted:
    def test_polygon_dict(self, central_aoi):
        parsed = parse_aoi(central_aoi)
        assert parsed.geometry["type"] == "Polygon"
        assert parsed.bounds == {
            "west": 500020.0,
            "south": 4599920.0,
            "east": 500080.0,
            "north": 4599980.0,
        }
        assert parsed.shapely.area == pytest.approx(3600.0)
        assert parsed.warnings == []

    def test_json_string_transport(self, central_aoi):
        """The multipart API delivers the AOI as a JSON string."""
        parsed = parse_aoi(json.dumps(central_aoi))
        assert parsed.geometry["type"] == "Polygon"
        assert parsed.bounds["west"] == 500020.0

    def test_bytes_transport(self, central_aoi):
        assert parse_aoi(json.dumps(central_aoi).encode()).geometry["type"] == "Polygon"

    def test_geojson_feature_wrapper(self, central_aoi):
        parsed = parse_aoi({"type": "Feature", "geometry": central_aoi, "properties": {}})
        assert parsed.geometry["type"] == "Polygon"

    def test_feature_collection_single_feature(self, central_aoi):
        parsed = parse_aoi(
            {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": central_aoi}]}
        )
        assert parsed.geometry["type"] == "Polygon"

    def test_feature_collection_multi_feature_unions(self, central_aoi):
        second = utm_polygon(500000.0, 4599900.0, 500060.0, 4599910.0)
        parsed = parse_aoi(
            {
                "type": "FeatureCollection",
                "features": [
                    {"type": "Feature", "geometry": central_aoi},
                    {"type": "Feature", "geometry": second},
                ],
            }
        )
        assert parsed.geometry["type"] == "MultiPolygon"
        assert len(parsed.geometry["coordinates"]) == 2
        assert parsed.shapely.area == pytest.approx(3600.0 + 600.0)

    def test_multipolygon(self, central_aoi):
        second = utm_polygon(500000.0, 4599900.0, 500060.0, 4599910.0)
        parsed = parse_aoi(
            {
                "type": "MultiPolygon",
                "coordinates": [central_aoi["coordinates"], second["coordinates"]],
            }
        )
        assert parsed.geometry["type"] == "MultiPolygon"
        assert parsed.shapely.area == pytest.approx(3600.0 + 600.0)

    def test_unclosed_ring_is_closed_and_warned(self, central_aoi):
        coords = [list(p) for p in central_aoi["coordinates"][0][:-1]]
        parsed = parse_aoi({"type": "Polygon", "coordinates": [coords]})
        assert parsed.geometry["coordinates"][0][0] == parsed.geometry["coordinates"][0][-1]
        assert any("closed" in w for w in parsed.warnings)

    def test_polygon_with_hole_is_accepted(self):
        """A ring inside the exterior ring is a valid hole, not a self-intersection."""
        parsed = parse_aoi(
            {
                "type": "Polygon",
                "coordinates": [
                    [[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]],
                    [[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]],
                ],
            }
        )
        assert parsed.shapely.area == pytest.approx(1600.0 - 100.0)


# --------------------------------------------------------------------------- #
# parse_aoi: rejections                                                        #
# --------------------------------------------------------------------------- #


class TestParseAoiRejected:
    def test_none(self):
        with pytest.raises(AoiValidationError) as exc:
            parse_aoi(None)
        assert exc.value.metadata["aoiPresent"] is False

    @pytest.mark.parametrize("bad", ["not json", "{", "[1,2"])
    def test_invalid_json(self, bad):
        with pytest.raises(AoiValidationError) as exc:
            parse_aoi(bad)
        assert exc.value.metadata["aoiStatus"] == STATUS_REJECTED_GEOMETRY

    @pytest.mark.parametrize("bad", [[1, 2], 5, None or 3.5])
    def test_non_object(self, bad):
        with pytest.raises(AoiValidationError):
            parse_aoi(bad)

    @pytest.mark.parametrize(
        "geom",
        [
            {"type": "Point", "coordinates": [1, 2]},
            {"type": "LineString", "coordinates": [[1, 2], [3, 4]]},
            {"type": "GeometryCollection", "geometries": []},
        ],
    )
    def test_unsupported_type(self, geom):
        with pytest.raises(AoiValidationError) as exc:
            parse_aoi(geom)
        assert "Unsupported AOI geometry type" in str(exc.value)

    def test_polygon_without_coordinates(self):
        with pytest.raises(AoiValidationError):
            parse_aoi({"type": "Polygon"})

    def test_ring_with_two_positions(self):
        with pytest.raises(AoiValidationError) as exc:
            parse_aoi({"type": "Polygon", "coordinates": [[[0, 0], [1, 1]]]})
        assert "at least 3 are required" in str(exc.value)

    def test_ring_too_short_to_have_area(self):
        with pytest.raises(AoiValidationError) as exc:
            parse_aoi({"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [2, 2], [0, 0]]]})
        assert exc.value.metadata["aoiStatus"] == STATUS_REJECTED_GEOMETRY

    def test_collinear_zero_area(self):
        with pytest.raises(AoiValidationError):
            parse_aoi({"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [2, 0], [0, 0]]]})

    def test_bowtie_self_intersection(self):
        with pytest.raises(AoiValidationError) as exc:
            parse_aoi(
                {"type": "Polygon", "coordinates": [[[0, 0], [4, 4], [4, 0], [0, 4], [0, 0]]]}
            )
        assert "Self-intersection" in str(exc.value)

    def test_non_finite_or_non_numeric_positions(self):
        for ring in (
            [["a", 2], [3, 4], [5, 6], ["a", 2]],
            [[None, 2], [3, 4], [5, 6], [None, 2]],
            [[float("nan"), 2], [3, 4], [5, 6], [0, 2]],
            [[float("inf"), 2], [3, 4], [5, 6], [0, 2]],
            [[True, 2], [3, 4], [5, 6], [0, 2]],
            [[1], [3, 4], [5, 6], [1]],
        ):
            with pytest.raises(AoiValidationError) as exc:
                parse_aoi({"type": "Polygon", "coordinates": [ring]})
            assert exc.value.metadata["aoiStatus"] == STATUS_REJECTED_GEOMETRY

    def test_empty_feature_collection(self):
        with pytest.raises(AoiValidationError):
            parse_aoi({"type": "FeatureCollection", "features": []})

    def test_feature_collection_with_unsupported_member(self, central_aoi):
        with pytest.raises(AoiValidationError):
            parse_aoi(
                {
                    "type": "FeatureCollection",
                    "features": [
                        {"type": "Feature", "geometry": central_aoi},
                        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [1, 2]}},
                    ],
                }
            )

    def test_feature_without_geometry(self):
        with pytest.raises(AoiValidationError):
            parse_aoi({"type": "Feature", "properties": {}})

    def test_empty_polygon_list_in_multipolygon(self):
        with pytest.raises(AoiValidationError):
            parse_aoi({"type": "MultiPolygon", "coordinates": [[]]})


# --------------------------------------------------------------------------- #
# CRS resolution                                                               #
# --------------------------------------------------------------------------- #


class TestAoiCrsResolution:
    def test_bare_geojson_uses_rfc7946_default_and_reports_it(self, geographic_central_aoi):
        parsed = parse_aoi(geographic_central_aoi)
        assert parsed.crs_source == GEOJSON_DEFAULT_CRS_SOURCE
        assert parsed.crs_label == GEOJSON_DEFAULT_CRS
        assert parsed.crs.equals(CRS.from_epsg(4326))

    def test_explicit_crs_argument_wins(self, central_aoi):
        parsed = parse_aoi(central_aoi, "EPSG:32643")
        assert parsed.crs_source == "explicit"
        assert parsed.crs_label == "EPSG:32643"

    def test_crs_member_on_geometry_is_used(self, central_aoi):
        geometry = dict(central_aoi)
        geometry["crs"] = {"type": "name", "properties": {"name": "EPSG:32643"}}
        parsed = parse_aoi(geometry)
        assert parsed.crs_source == "explicit"
        assert parsed.crs_label == "EPSG:32643"

    def test_legacy_geojson_crs_name_urn(self, central_aoi):
        geometry = dict(central_aoi)
        geometry["crs"] = {
            "type": "name",
            "properties": {"name": "urn:ogc:def:crs:EPSG::32643"},
        }
        assert parse_aoi(geometry).crs_label == "EPSG:32643"

    def test_legacy_geojson_crs_code_form(self, central_aoi):
        geometry = dict(central_aoi)
        geometry["crs"] = {"type": "EPSG", "properties": {"code": 32643}}
        assert parse_aoi(geometry).crs_label == "EPSG:32643"

    def test_explicit_argument_beats_geometry_member(self, central_aoi):
        geometry = dict(central_aoi)
        geometry["crs"] = "EPSG:32643"
        parsed = parse_aoi(geometry, "EPSG:3857")
        assert parsed.crs_label == "EPSG:3857"

    def test_unparseable_crs_raises_crs_error(self, central_aoi):
        with pytest.raises(AoiCrsError) as exc:
            parse_aoi(central_aoi, "definitely-not-a-crs")
        assert exc.value.metadata["aoiStatus"] == STATUS_REJECTED_CRS

    def test_crs_error_is_a_roi_crop_error(self, central_aoi):
        from app.tools.roi_crop import RoiCropError

        with pytest.raises(RoiCropError):
            parse_aoi(central_aoi, "nope")


# --------------------------------------------------------------------------- #
# crop_raster: geometry                                                       #
# --------------------------------------------------------------------------- #


class TestCropGeometry:
    def test_no_aoi_returns_original_dimensions(self, georeferenced_raster):
        scope = no_aoi_scope(georeferenced_raster)
        assert scope.aoi_applied is False
        assert scope.status == STATUS_NOT_REQUESTED
        assert scope.raster_path == georeferenced_raster
        assert scope.analyzed_dimensions == scope.original_dimensions == {"width": 10, "height": 10}

    def test_central_aoi_reduces_dimensions(self, georeferenced_raster, central_aoi):
        _, inside, scope = crop_raster(georeferenced_raster, central_aoi)
        assert scope.aoi_applied is True
        assert scope.status == STATUS_APPLIED
        assert scope.scope == SCOPE_MASKED
        assert scope.original_dimensions == {"width": 10, "height": 10}
        assert scope.analyzed_dimensions["width"] >= 6
        assert scope.analyzed_dimensions["height"] >= 6
        assert scope.analyzed_dimensions["width"] < 10
        assert scope.analyzed_dimensions["height"] < 10
        assert_covers(scope, scope.aoi_bounds)
        assert scope.is_georeferenced is True

    def test_masked_outside_pixels_equal_nodata(self, georeferenced_raster, central_aoi):
        data, inside, scope = crop_raster(georeferenced_raster, central_aoi)
        assert data.shape == (1, 6, 6)
        assert inside.shape == (6, 6)
        assert bool(inside.all()), "central AOI should cover the whole crop window"

    def test_pixels_outside_a_non_rectangular_aoi_become_nodata(
        self, georeferenced_raster
    ):
        """A triangular AOI leaves half of its bounding window masked out."""
        triangle = {
            "type": "Polygon",
            "crs": "EPSG:32643",
            "coordinates": [
                [[500020.0, 4599920.0], [500080.0, 4599920.0],
                 [500080.0, 4599940.0], [500020.0, 4599920.0]]
            ],
        }
        data, inside, scope = crop_raster(georeferenced_raster, triangle)
        assert not bool(inside.all())
        assert scope.scope == SCOPE_MASKED
        assert scope.masked_out_pixels > 0
        assert scope.nodata is not None
        for band in data:
            assert np.all(band[~inside] == scope.nodata)
        # Inside pixels keep real data; outside pixels are the sentinel.
        assert not np.any(data[0][~inside] == 100)
        assert scope.valid_pixels == int(inside.sum())

    def test_inside_pixels_preserve_source_values(self, georeferenced_raster, central_aoi):
        with rasterio.open(georeferenced_raster) as src:
            source = src.read(1)
        data, inside, _ = crop_raster(georeferenced_raster, central_aoi)
        expected = source[2:8, 2:8]
        assert np.array_equal(data[0][inside], expected[inside])

    def test_whole_scene_aoi_changes_nothing(self, georeferenced_raster, whole_scene_aoi):
        data, inside, scope = crop_raster(georeferenced_raster, whole_scene_aoi)
        assert scope.analyzed_dimensions == {"width": 10, "height": 10}
        assert scope.masked_out_pixels == 0
        assert bool(inside.all())
        assert np.array_equal(data[0], rasterio.open(georeferenced_raster).read(1))

    def test_partial_overlap_warns(self, georeferenced_raster):
        """An AOI hanging off the raster edges is clipped, and the loss is reported."""
        aoi = utm_polygon(499980.0, 4599950.0, 500050.0, 4600010.0)
        _, inside, scope = crop_raster(georeferenced_raster, aoi)
        assert any("extends beyond the raster footprint" in w for w in scope.warnings)
        assert scope.aoi_applied is True
        # Only the overlapping 5x5 block is analyzed, and it is fully covered.
        assert scope.analyzed_dimensions == {"width": 5, "height": 5}
        assert bool(inside.all())

    def test_multipolygon_keeps_both_parts(self, georeferenced_raster, central_aoi):
        second = utm_polygon(500000.0, 4599900.0, 500060.0, 4599910.0)
        data, inside, scope = crop_raster(
            georeferenced_raster,
            {
                "type": "MultiPolygon",
                "crs": "EPSG:32643",
                "coordinates": [central_aoi["coordinates"], second["coordinates"]],
            },
        )
        assert scope.aoi_applied is True
        # Two disjoint blocks: a 6x6 (cols 2-8, rows 2-8) and a 6x1
        # (cols 0-6, row 8). Their envelope is 8x8 = 64 pixels, of which 42 are
        # inside the AOI; the 22 in-between pixels must be masked out.
        assert scope.analyzed_dimensions == {"width": 8, "height": 8}
        assert scope.aoi_masked_pixels == 36 + 6
        assert scope.valid_pixels == 42
        assert scope.masked_out_pixels == 64 - 42

    def test_outside_aoi_raises(self, georeferenced_raster, outside_aoi):
        with pytest.raises(AoiOutsideRasterError) as exc:
            crop_raster(georeferenced_raster, outside_aoi)
        md = exc.value.metadata
        assert md["aoiStatus"] == STATUS_REJECTED_OUTSIDE
        assert md["aoiApplied"] is False
        assert "does not intersect" in str(exc.value)
        # The message must state both footprints so the mismatch is debuggable.
        assert "500000.0" in str(exc.value) and "900000.0" in str(exc.value)

    def test_non_georeferenced_raster_refuses_to_clip(self, no_crs_raster, central_aoi):
        with pytest.raises(AoiGeoreferenceError) as exc:
            crop_raster(no_crs_raster, central_aoi)
        md = exc.value.metadata
        assert md["aoiStatus"] == STATUS_NOT_GEOREFERENCED
        assert md["isGeoreferenced"] is False
        assert md["aoiApplied"] is False
        assert "NOT performed" in str(exc.value)


def utm_polygon(west, south, east, north) -> dict:
    """A closed Polygon in the EPSG:32643 metres used by the 10x10 fixtures."""
    return {
        "type": "Polygon",
        "crs": "EPSG:32643",
        "coordinates": [
            [[west, south], [east, south], [east, north], [west, north], [west, south]]
        ],
    }


def assert_covers(scope, bounds: dict) -> None:
    """The analyzed window must fully contain the AOI bounds (never under-cover)."""
    assert scope.analyzed_bounds["west"] <= bounds["west"] + 1e-9
    assert scope.analyzed_bounds["south"] <= bounds["south"] + 1e-9
    assert scope.analyzed_bounds["east"] >= bounds["east"] - 1e-9
    assert scope.analyzed_bounds["north"] >= bounds["north"] - 1e-9


# --------------------------------------------------------------------------- #
# crop_raster: CRS                                                             #
# --------------------------------------------------------------------------- #


class TestCropCrs:
    def test_matching_crs_is_not_transformed(self, georeferenced_raster, central_aoi):
        _, _, scope = crop_raster(georeferenced_raster, central_aoi, aoi_crs="EPSG:32643")
        assert scope.crs_transformed is False
        assert scope.crs == "EPSG:32643"
        assert scope.aoi_crs == "EPSG:32643"
        assert scope.aoi_crs_source == "explicit"

    def test_mismatched_crs_is_transformed_into_raster_crs(
        self, georeferenced_raster, central_aoi
    ):
        # Same polygon expressed in EPSG:4326 over the UTM fixture.
        from pyproj import Transformer

        to_wgs84 = Transformer.from_crs(32643, 4326, always_xy=True)
        ring = []
        for easting, northing in (
            (500020.0, 4599920.0),
            (500080.0, 4599920.0),
            (500080.0, 4599980.0),
            (500020.0, 4599980.0),
        ):
            lon, lat = to_wgs84.transform(easting, northing)[:2]
            ring.append([float(lon), float(lat)])
        ring.append(list(ring[0]))
        _, inside, scope = crop_raster(
            georeferenced_raster, {"type": "Polygon", "coordinates": [ring]}
        )
        assert scope.crs_transformed is True
        assert scope.crs == "EPSG:32643"
        assert scope.aoi_crs == "EPSG:4326"
        assert scope.aoi_crs_source == GEOJSON_DEFAULT_CRS_SOURCE
        assert scope.analyzed_dimensions["width"] >= 6
        assert scope.analyzed_dimensions["height"] >= 6
        assert any("was transformed" in w for w in scope.warnings)
        assert int(inside.sum()) >= 36
        assert scope.valid_pixels == int(inside.sum())

    def test_geographic_raster_with_bare_geojson_aoi(
        self, geographic_raster, geographic_central_aoi
    ):
        """The frontend's default case: WGS84 polygon on a WGS84 raster."""
        _, inside, scope = crop_raster(geographic_raster, geographic_central_aoi)
        assert scope.crs_transformed is False
        assert scope.crs == "EPSG:4326"
        assert scope.aoi_crs == GEOJSON_DEFAULT_CRS
        assert scope.aoi_crs_source == GEOJSON_DEFAULT_CRS_SOURCE
        assert scope.analyzed_dimensions["width"] >= 6
        assert scope.analyzed_dimensions["height"] >= 6
        assert_covers(scope, scope.aoi_bounds)
        assert int(inside.sum()) >= 36
        assert scope.valid_pixels == int(inside.sum())

    def test_wrong_crs_yields_no_intersection_not_a_wrong_crop(
        self, georeferenced_raster
    ):
        """A polygon in the wrong CRS must not silently produce a bogus crop."""
        # EPSG:32643 coordinates interpreted as EPSG:4326 (degrees) -> far away.
        aoi = {
            "type": "Polygon",
            "coordinates": [[[500020.0, 4599920.0], [500080.0, 4599920.0],
                             [500080.0, 4599980.0], [500020.0, 4599980.0],
                             [500020.0, 4599920.0]]],
        }
        with pytest.raises(AoiOutsideRasterError):
            crop_raster(georeferenced_raster, aoi)

    def test_all_touched_selects_more_pixels(self, georeferenced_raster, central_aoi):
        _, _, s_default = crop_raster(georeferenced_raster, central_aoi)
        aoi_tight = utm_polygon(500025.0, 4599925.0, 500075.0, 4599975.0)
        _, _, s_centre = crop_raster(georeferenced_raster, aoi_tight)
        _, _, s_touched = crop_raster(georeferenced_raster, aoi_tight, all_touched=True)
        assert s_touched.aoi_masked_pixels > s_centre.aoi_masked_pixels
        assert s_default.aoi_masked_pixels == 36


# --------------------------------------------------------------------------- #
# crop_raster: nodata and dtypes                                               #
# --------------------------------------------------------------------------- #


class TestCropNodata:
    def test_source_nodata_is_preserved(self, nodata_raster, central_aoi):
        _, _, scope = crop_raster(nodata_raster, central_aoi)
        assert scope.nodata == -9999
        assert scope.nodata_source == "dataset"
        assert scope.warnings == []

    def test_source_nodata_inside_aoi_is_excluded_from_valid_pixels(
        self, nodata_raster, central_aoi
    ):
        """The 6x6 central block is exactly the AOI and it is all real data."""
        _, _, scope = crop_raster(nodata_raster, central_aoi)
        assert scope.aoi_masked_pixels == 36
        assert scope.valid_pixels == 36

    def test_float_raster_without_nodata_gets_nan_sentinel(self, georeferenced_raster, central_aoi):
        import shutil

        from pathlib import Path

        path = Path(str(georeferenced_raster)).parent / "float_no_nodata.tif"
        arr = np.arange(100, dtype=np.float32).reshape(10, 10)
        with rasterio.open(
            path, "w", driver="GTiff", width=10, height=10, count=1, dtype="float32",
            crs=CRS.from_epsg(32643), transform=from_origin(500000, 4600000, 10, 10),
        ) as dst:
            dst.write(arr, 1)
        _, _, scope = crop_raster(path, central_aoi)
        assert np.isnan(scope.nodata)
        assert scope.nodata_source == "assigned_nan"
        shutil.copy(path, georeferenced_raster)

    def test_sentinel_never_collides_with_real_data(self, tmp_path, central_aoi):
        """A uint16 raster using 0 must get the max sentinel, not 0."""
        path = tmp_path / "full_range.tif"
        arr = np.zeros((10, 10), dtype=np.uint16)
        arr[0, 0] = 0  # dtype minimum is present in the data
        with rasterio.open(
            path, "w", driver="GTiff", width=10, height=10, count=1, dtype="uint16",
            crs=CRS.from_epsg(32643), transform=from_origin(500000, 4600000, 10, 10),
        ) as dst:
            dst.write(arr, 1)
        _, _, scope = crop_raster(path, central_aoi)
        assert scope.nodata == 65535
        assert scope.nodata_source == "assigned_dtype_max_sentinel"
        assert "verified absent" in " ".join(scope.warnings)

    def test_valid_pixels_ignore_the_assigned_sentinel(
        self, georeferenced_raster, central_aoi
    ):
        """Real pixels equal to the sentinel must still count as valid."""
        _, _, scope = crop_raster(georeferenced_raster, central_aoi)
        assert scope.valid_pixels == 36
        assert scope.aoi_masked_pixels == 36

    def test_dtypes_are_preserved(self, multiband_raster, central_aoi):
        data, _, scope = crop_raster(multiband_raster, central_aoi)
        assert str(data.dtype) == "uint16"
        assert scope.dtypes == ["uint16"] * 4
        assert scope.band_count == 4

    def test_band_count_and_shape_preserved(self, ndvi_ndwi_raster, central_aoi):
        data, _, scope = crop_raster(ndvi_ndwi_raster, central_aoi)
        assert data.shape == (3, 6, 6)
        assert scope.band_count == 3


# --------------------------------------------------------------------------- #
# aoi_scope context manager                                                    #
# --------------------------------------------------------------------------- #


class TestAoiScopeContextManager:
    def test_derived_raster_preserves_the_source_contract(self, multiband_raster, central_aoi):
        with aoi_scope_cm(multiband_raster, central_aoi) as scope:
            derived = scope.raster_path
            assert derived != multiband_raster
            assert derived.exists()
            with rasterio.open(derived) as ds:
                assert ds.count == 4
                assert ds.dtypes == ("uint16",) * 4
                assert ds.nodata == 0
                assert ds.descriptions == ("red", "green", "blue", "nir")
                assert ds.crs == CRS.from_epsg(32643)
                assert ds.res == (10.0, 10.0)
                assert (ds.width, ds.height) == (6, 6)
                # The exact AOI mask survives as an internal mask band.
                assert int((ds.dataset_mask() > 0).sum()) == 36

    def test_source_raster_is_never_modified(self, multiband_raster, central_aoi):
        with rasterio.open(multiband_raster) as before:
            snapshot = before.read()
            nodata_before = before.nodata
        with aoi_scope_cm(multiband_raster, central_aoi):
            pass
        with rasterio.open(multiband_raster) as after:
            assert np.array_equal(after.read(), snapshot)
            assert after.nodata == nodata_before
            assert after.descriptions == ("red", "green", "blue", "nir")
            assert (after.width, after.height) == (10, 10)

    def test_temporary_raster_is_cleaned_up(self, multiband_raster, central_aoi):
        with aoi_scope_cm(multiband_raster, central_aoi) as scope:
            derived = scope.raster_path
            assert derived.exists()
        assert not derived.exists()
        assert scope.raster_path == multiband_raster

    def test_no_aoi_hands_back_the_original_file(self, multiband_raster):
        with aoi_scope_cm(multiband_raster, None) as scope:
            assert scope.raster_path == multiband_raster
            assert scope.aoi_applied is False
            assert scope.status == STATUS_NOT_REQUESTED
            assert scope.scope is None
            with rasterio.open(scope.raster_path) as ds:
                assert (ds.width, ds.height) == (10, 10)

    def test_window_mode_extracts_without_masking(self, georeferenced_raster, central_aoi):
        with aoi_scope_cm(georeferenced_raster, central_aoi, apply_mask=False) as scope:
            assert scope.scope == SCOPE_WINDOW
            assert scope.aoi_masked_pixels is None
            assert scope.masked_out_pixels is None
            assert scope.nodata is None
            with rasterio.open(scope.raster_path) as ds:
                assert (ds.width, ds.height) == (6, 6)
                assert ds.dataset_mask().min() == 255, "no polygon mask may be applied"

    def test_window_mode_never_under_covers_the_aoi(self, georeferenced_raster):
        """A sub-pixel AOI must still yield a window that contains it."""
        aoi = {
            "type": "Polygon",
            "crs": "EPSG:32643",
            "coordinates": [[[500020.1, 4599920.1], [500079.9, 4599920.1],
                             [500079.9, 4599979.9], [500020.1, 4599979.9],
                             [500020.1, 4599920.1]]],
        }
        with aoi_scope_cm(georeferenced_raster, aoi, apply_mask=False) as scope:
            assert scope.analyzed_dimensions == {"width": 6, "height": 6}
            assert scope.analyzed_bounds["west"] <= 500020.1
            assert scope.analyzed_bounds["east"] >= 500079.9
            assert scope.analyzed_bounds["south"] <= 4599920.1
            assert scope.analyzed_bounds["north"] >= 4599979.9

    def test_georeferencing_is_carried_into_the_derived_file(
        self, georeferenced_raster, central_aoi
    ):
        with rasterio.open(georeferenced_raster) as src:
            source_transform = src.transform
        with aoi_scope_cm(georeferenced_raster, central_aoi) as scope:
            with rasterio.open(scope.raster_path) as ds:
                assert ds.transform.c == pytest.approx(500020.0)
                assert ds.transform.f == pytest.approx(4599980.0)
                assert ds.transform.a == source_transform.a
                assert ds.transform.e == source_transform.e
                assert ds.bounds.left == pytest.approx(500020.0)
                assert ds.bounds.top == pytest.approx(4599980.0)

    def test_failures_propagate_without_leaking_temp_files(
        self, georeferenced_raster, outside_aoi
    ):
        with pytest.raises(AoiOutsideRasterError):
            with aoi_scope_cm(georeferenced_raster, outside_aoi):
                pass

    def test_reported_dimensions_distinguish_source_from_analysis(
        self, georeferenced_raster, central_aoi
    ):
        with aoi_scope_cm(georeferenced_raster, central_aoi) as scope:
            assert scope.original_dimensions == {"width": 10, "height": 10}
            assert scope.analyzed_dimensions == {"width": 6, "height": 6}
            assert scope.original_bounds["west"] == pytest.approx(500000.0)
            assert scope.analyzed_bounds["west"] == pytest.approx(500020.0)


# --------------------------------------------------------------------------- #
# Reporting                                                                    #
# --------------------------------------------------------------------------- #


class TestAoiReporting:
    def test_summary_is_compact_and_json_safe(self, georeferenced_raster, central_aoi):
        with aoi_scope_cm(georeferenced_raster, central_aoi) as scope:
            summary = scope.summary()
        assert set(summary) == {
            "aoiApplied",
            "aoiScope",
            "isGeoreferenced",
            "aoiStatus",
            "originalDimensions",
            "analyzedDimensions",
            "crs",
        }
        json.dumps(summary)

    def test_metadata_is_json_serializable(self, georeferenced_raster, central_aoi):
        with aoi_scope_cm(georeferenced_raster, central_aoi) as scope:
            md = scope.metadata()
        assert md["aoiPresent"] is True
        assert md["aoiApplied"] is True
        assert md["aoiStatus"] == STATUS_APPLIED
        assert md["aoiScope"] == SCOPE_MASKED
        assert md["aoiGeometry"]["type"] == "Polygon"
        assert md["aoiBounds"]["west"] == pytest.approx(500020.0)
        assert md["aoiMaskedPixels"] == 36
        assert md["maskedOutPixels"] == 0
        assert md["isGeoreferenced"] is True
        json.dumps(md)

    def test_no_aoi_metadata_reports_absent(self, georeferenced_raster):
        md = no_aoi_scope(georeferenced_raster).metadata()
        assert md["aoiPresent"] is False
        assert md["aoiApplied"] is False
        assert md["aoiStatus"] == STATUS_NOT_REQUESTED
        json.dumps(md)


# --------------------------------------------------------------------------- #
# validate_aoi_only                                                            #
# --------------------------------------------------------------------------- #


class TestValidateAoiOnly:
    def test_absent(self):
        report = validate_aoi_only(None)
        assert report["aoiPresent"] is False
        assert report["aoiStatus"] == STATUS_NOT_REQUESTED

    def test_valid_but_not_applied(self, geographic_central_aoi):
        report = validate_aoi_only(geographic_central_aoi)
        assert report["aoiPresent"] is True
        assert report["aoiApplied"] is False
        assert report["aoiStatus"] == STATUS_VALIDATED
        assert report["aoiCrs"] == GEOJSON_DEFAULT_CRS
        assert report["aoiCrsSource"] == GEOJSON_DEFAULT_CRS_SOURCE
        json.dumps(report)

    def test_invalid_geometry(self):
        report = validate_aoi_only({"type": "Point", "coordinates": [1, 2]})
        assert report["aoiStatus"] == STATUS_REJECTED_GEOMETRY
        assert "Unsupported AOI geometry type" in report["reason"]

    def test_invalid_crs(self, central_aoi):
        report = validate_aoi_only(central_aoi, "nope")
        assert report["aoiStatus"] == STATUS_REJECTED_CRS
