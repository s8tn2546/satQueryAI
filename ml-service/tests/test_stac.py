"""Tests for STAC scene search + AOI-only acquisition.

- tools-level: /stac/search validation, band/role resolution, deterministic
  dedupe keys, offline honesty, fixture labelling, AOI acquisition, analysis
  raster + preview persistence, validation integration.
- API-level: POST /stac/search and /stac/ingest via dependency-overridden
  providers (no network), offline failure, no-fabrication assertions.

Never asserts that fixture data is real: fixture results must always be
labelled ``mock`` with a stated reason.
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from fastapi.testclient import TestClient
from rasterio.transform import from_origin

from app.api.stac import resolve_provider
from app.geospatial.crs import parse_crs
from app.main import app
from app.services.satellite_provider import (
    BandUnavailableError,
    SceneNotFoundError,
    SatelliteProvider,
    SceneInfo,
    SceneAsset,
    FetchedWindow,
    BandWindow,
    StacSatelliteProvider,
    SENTINEL_2_L2A,
    resolve_collection,
)
from app.tools.roi_crop import transform_aoi_to_crs
from app.tools.stac import (
    StacValidationError,
    ReprojectionUnsupportedError,
    build_dedupe_key,
    canonical_aoi_json,
    ingest_scene,
    resolve_roles,
    search_scenes,
    validate_date_window,
)

client = TestClient(app)

AOI = {
    "type": "Polygon",
    "coordinates": [[[30.0, 60.0], [30.5, 60.0], [30.5, 60.5], [30.0, 60.5], [30.0, 60.0]]],
}


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #


def _fake_real_provider(tmp_path: Path) -> SatelliteProvider:
    """A network-free stand-in for StacSatelliteProvider.

    Generates local georeferenced COG-like rasters (synthetic pixel values,
    honest geospatial metadata) so the real ingest code path runs without a
    network. Clearly a test double; it is NOT the fixture provider.
    """
    from shapely.geometry import shape

    class _Fake(SatelliteProvider):
        name = "fake-real-stac"

        def _window(self, collection, aoi, aoi_crs, bands):
            cfg = resolve_collection(None, collection)
            asset_crs = parse_crs("EPSG:32643")
            geom = transform_aoi_to_crs(shape(aoi), parse_crs(aoi_crs), asset_crs)
            minx, miny, maxx, maxy = geom.bounds
            res = cfg["resolution"]
            width = min(max(int((maxx - minx) / res), 1), 6)
            height = min(max(int((maxy - miny) / res), 1), 6)
            transform = from_origin(minx, maxy, res, res)
            arrays = []
            for i, role in enumerate(bands):
                asset_name = cfg["band_roles"][role]
                base = 500 + 50 * i
                data = np.full((height, width), base, dtype=np.uint16)
                data[height // 4: 3 * height // 4, width // 4: 3 * width // 4] = base + 200
                arrays.append(
                    BandWindow(asset=asset_name, data=data, dtype="uint16",
                               nodata=None, eo_common_name=role)
                )
            return FetchedWindow(
                bands=arrays, transform=transform, crs="EPSG:32643",
                width=width, height=height, nodata=None,
                native_crs_bounds={
                    "west": float(transform.c),
                    "south": float(transform.f + transform.e * height),
                    "east": float(transform.c + transform.a * width),
                    "north": float(transform.f),
                },
                method="cog-window-read", warnings=[],
            )

        def search_scenes(self, *, collection, aoi, start, end, cloud_max, limit):
            return [self.get_scene_metadata(collection=collection,
                                            scene_id="REAL-S2-TEST")]

        def get_scene_metadata(self, *, collection, scene_id):
            cfg = resolve_collection(None, collection)
            return SceneInfo(
                scene_id=scene_id, collection=cfg["collection"], provider=self.name,
                platform="sentinel-2a", instrument="sentinel-2",
                datetime="2025-04-01T00:00:00Z", crs="EPSG:32643",
                resolution=cfg["resolution"],
                assets=[SceneAsset(name=n, href=f"file://{n}", role=r, usable=True)
                        for r, n in cfg["band_roles"].items()],
                band_roles=dict(cfg["band_roles"]), provider_ref=scene_id,
            )

        def fetch_scene_aoi(self, *, collection, scene_id, aoi, aoi_crs, bands):
            return self._window(collection, aoi, aoi_crs, bands)

    return _Fake()


@pytest.fixture
def fixture_provider():
    from app.services.satellite_provider import FixtureSatelliteProvider

    provider = FixtureSatelliteProvider()
    app.dependency_overrides[resolve_provider] = lambda: provider
    yield provider
    app.dependency_overrides.pop(resolve_provider, None)


@pytest.fixture
def real_provider(tmp_path):
    provider = _fake_real_provider(tmp_path)
    app.dependency_overrides[resolve_provider] = lambda: provider
    yield provider
    app.dependency_overrides.pop(resolve_provider, None)


@pytest.fixture
def offline_provider():
    from app.services.satellite_provider import OfflineSatelliteProvider

    app.dependency_overrides[resolve_provider] = lambda: OfflineSatelliteProvider()
    yield
    app.dependency_overrides.pop(resolve_provider, None)


def _post_search(payload):
    return client.post("/stac/search", json=payload)


def _post_ingest(payload):
    return client.post("/stac/ingest", json=payload)


# --------------------------------------------------------------------------- #
# Tools-level: validation & deterministic helpers                              #
# --------------------------------------------------------------------------- #


class TestValidation:
    def test_date_window_valid(self):
        s, e, w = validate_date_window("2025-01-01", "2025-06-01", today=_dt.date(2025, 7, 1))
        assert (s, e) == ("2025-01-01", "2025-06-01")
        assert w == []

    def test_date_window_reversed_rejected(self):
        with pytest.raises(StacValidationError):
            validate_date_window("2025-06-01", "2025-01-01", today=_dt.date(2025, 7, 1))

    def test_date_window_future_rejected(self):
        with pytest.raises(StacValidationError):
            validate_date_window("2026-01-01", "2026-06-01", today=_dt.date(2025, 7, 1))

    def test_date_window_span_cap(self):
        with pytest.raises(StacValidationError):
            validate_date_window("1989-01-01", "2025-01-01", today=_dt.date(2026, 1, 1))


class TestRolesAndDedupe:
    def test_default_roles(self):
        from app.services.satellite_provider import resolve_collection

        cfg = resolve_collection(None, "sentinel-2-l2a")
        roles = resolve_roles(cfg, None)
        assert roles == ["blue", "green", "red", "nir"]

    def test_asset_name_alias_accepted(self):
        cfg = resolve_collection(None, "landsat-c2-l2")
        # 'nir08' is the landsat asset name for the internal 'nir' role.
        roles = resolve_roles(cfg, ["blue", "nir08"])
        assert roles == ["blue", "nir"]

    def test_unknown_band_rejected(self):
        cfg = resolve_collection(None, "sentinel-2-l2a")
        with pytest.raises(StacValidationError):
            resolve_roles(cfg, ["coastal"])

    def test_canonical_aoi_deterministic_and_rounded(self):
        a = json.loads(canonical_aoi_json(AOI))
        b = json.loads(canonical_aoi_json(AOI))
        assert a == b == json.loads(canonical_aoi_json(AOI))
        # Coordinates are rounded to 6 decimal places.
        coord = a["coordinates"][0][0]
        assert isinstance(coord[0], float) and round(coord[0], 6) == coord[0]

    def test_dedupe_key_deterministic(self):
        from app.services.satellite_provider import FixtureSatelliteProvider

        p = FixtureSatelliteProvider()
        k1 = build_dedupe_key(p, "sentinel-2-l2a", "S2", canonical_aoi_json(AOI), ["blue", "red"], "EPSG:32643")
        k2 = build_dedupe_key(p, "sentinel-2-l2a", "S2", canonical_aoi_json(AOI), ["blue", "red"], "EPSG:32643")
        assert k1 == k2
        assert k1.startswith("stac:stac-fixture:sentinel-2-l2a:S2:")
        assert "blue,red" in k1
        # Different bands or CRS -> different key.
        k3 = build_dedupe_key(p, "sentinel-2-l2a", "S2", canonical_aoi_json(AOI), ["blue"], "EPSG:32643")
        assert k3 != k1


# --------------------------------------------------------------------------- #
# Tools-level: search                                                          #
# --------------------------------------------------------------------------- #


class TestSearchTool:
    def test_fixture_search_labels_mock(self):
        from app.services.satellite_provider import FixtureSatelliteProvider

        r = search_scenes(
            FixtureSatelliteProvider(), sensor="sentinel-2", aoi=AOI,
            start="2025-01-01", end="2025-12-31", today=_dt.date(2026, 1, 1),
        )
        assert r["count"] == 2
        assert r["mock"] is True
        assert r["reason"]
        assert all(s["mock"] for s in r["scenes"])
        assert r["warnings"][0] == r["reason"]

    def test_fixture_cloud_filter(self):
        from app.services.satellite_provider import FixtureSatelliteProvider

        r = search_scenes(
            FixtureSatelliteProvider(), sensor="sentinel-2", aoi=AOI,
            start="2025-01-01", end="2025-12-31", cloud_max=10,
            today=_dt.date(2026, 1, 1),
        )
        # Only the 5% cloud scene survives a 10% cap among the two fixtures.
        assert r["count"] == 1
        assert r["scenes"][0]["sceneId"] == "fixture-s2a-20250301"

    def test_fixture_date_filter(self):
        from app.services.satellite_provider import FixtureSatelliteProvider

        r = search_scenes(
            FixtureSatelliteProvider(), sensor="sentinel-2", aoi=AOI,
            start="2025-03-10", end="2025-12-31", today=_dt.date(2026, 1, 1),
        )
        assert r["count"] == 1
        assert r["scenes"][0]["sceneId"] == "fixture-s2a-20250315"

    def test_empty_result_is_valid_not_failure(self):
        from app.services.satellite_provider import FixtureSatelliteProvider

        r = search_scenes(
            FixtureSatelliteProvider(), sensor="landsat-9", aoi=AOI,
            start="1900-01-01", end="1900-12-31", today=_dt.date(2026, 1, 1),
        )
        assert r["count"] == 0
        assert r["scenes"] == []
        assert any("No scenes matched" in w for w in r["warnings"])

    def test_unsupported_collection_rejected(self):
        from app.services.satellite_provider import (
            FixtureSatelliteProvider,
            UnsupportedCollectionError,
        )

        with pytest.raises(UnsupportedCollectionError):
            search_scenes(
                FixtureSatelliteProvider(), sensor="modis", aoi=AOI,
                start="2025-01-01", end="2025-12-31",
                today=_dt.date(2026, 1, 1),
            )

    def test_invalid_aoi_rejected(self):
        from app.services.satellite_provider import FixtureSatelliteProvider

        with pytest.raises(StacValidationError):
            search_scenes(
                FixtureSatelliteProvider(), sensor="sentinel-2",
                aoi={"type": "Point", "coordinates": [0, 0]},
                start="2025-01-01", end="2025-12-31",
                today=_dt.date(2026, 1, 1),
            )


# --------------------------------------------------------------------------- #
# Tools-level: ingest                                                          #
# --------------------------------------------------------------------------- #


class TestIngestTool:
    def test_fixture_ingest_writes_analysis_and_preview(self, tmp_path, fixture_provider):
        r = ingest_scene(
            fixture_provider, collection="sentinel-2-l2a",
            scene_id="fixture-s2a-20250301", aoi=AOI, out_dir=tmp_path,
        )
        analysis = Path(r["analysisRaster"])
        assert analysis.exists() and analysis.stat().st_size > 0
        with rasterio.open(analysis) as src:
            assert src.count == 4
            assert list(src.descriptions) == ["blue", "green", "red", "nir"]
            assert src.crs == rasterio.crs.CRS.from_epsg(32643)
            assert src.width == src.height == 16  # base window
        preview = r["preview"]
        assert preview is not None and Path(preview["filePath"]).exists()
        assert preview["channels"] == ["red", "green", "blue"]
        assert r["analysis"]["method"] == "fixture-cog-window-read"
        assert r["mock"] is True and r["reason"]
        assert r["validation"]["valid"] is True
        assert r["validation"]["crs"] == "EPSG:32643"
        assert r["dedupeKey"].startswith("stac:stac-fixture:sentinel-2-l2a:fixture-s2a-20250301:")

    def test_fixture_ingest_past_null_values(self, tmp_path, fixture_provider):
        r = ingest_scene(
            fixture_provider, collection="sentinel-2-l2a",
            scene_id="fixture-s2a-20250301", aoi=AOI, out_dir=tmp_path,
        )
        raw = json.dumps(r)
        assert "NaN" not in raw and "Infinity" not in raw

    def test_missing_scene_rejected(self, tmp_path, fixture_provider):
        with pytest.raises(SceneNotFoundError):
            ingest_scene(
                fixture_provider, collection="sentinel-2-l2a",
                scene_id="does-not-exist", aoi=AOI, out_dir=tmp_path,
            )

    def test_missing_band_rejected(self, tmp_path, fixture_provider):
        with pytest.raises((StacValidationError, BandUnavailableError)):
            ingest_scene(
                fixture_provider, collection="sentinel-2-l2a",
                scene_id="fixture-s2a-20250301", aoi=AOI,
                bands=["coastal"], out_dir=tmp_path,
            )

    def test_target_crs_mismatch_rejected(self, tmp_path, fixture_provider):
        with pytest.raises(ReprojectionUnsupportedError):
            ingest_scene(
                fixture_provider, collection="sentinel-2-l2a",
                scene_id="fixture-s2a-20250301", aoi=AOI,
                target_crs="EPSG:4326", out_dir=tmp_path,
            )

    def test_target_crs_matching_scene_ok(self, tmp_path, fixture_provider):
        r = ingest_scene(
            fixture_provider, collection="sentinel-2-l2a",
            scene_id="fixture-s2a-20250301", aoi=AOI,
            target_crs="EPSG:32643", out_dir=tmp_path,
        )
        assert r["analysis"]["crs"] == "EPSG:32643"
        assert r["dedupeKey"].endswith(":EPSG:32643")

    def test_real_provider_path(self, tmp_path, real_provider):
        r = ingest_scene(
            real_provider, collection="sentinel-2-l2a",
            scene_id="REAL-S2-TEST", aoi=AOI, out_dir=tmp_path,
        )
        assert r["mock"] is False
        assert r["source"] == "fake-real-stac"
        assert r["validation"]["valid"] is True
        assert r["analysis"]["method"] == "cog-window-read"
        assert r["analysis"]["scope"] == "cog-window-read"
        assert r["preview"] is not None
        assert Path(r["analysisRaster"]).exists()


# --------------------------------------------------------------------------- #
# API-level: /stac/search                                                      #
# --------------------------------------------------------------------------- #


class TestSearchApi:
    def test_empty_payload_rejected(self):
        assert _post_search({}).status_code == 422

    def test_missing_aoi_rejected(self):
        res = _post_search({"sensor": "sentinel-2", "dateRange": {"start": "2025-01-01", "end": "2025-02-01"}})
        assert res.status_code == 422

    def test_success_schema(self, fixture_provider):
        res = _post_search({
            "sensor": "sentinel-2",
            "dateRange": {"start": "2025-01-01", "end": "2025-12-31"},
            "aoi": AOI,
            "cloudMax": 20,
            "limit": 5,
        })
        assert res.status_code == 200
        body = res.json()
        assert body["tool"] == "stac-search"
        assert body["status"] == "success"
        assert body["result"]["count"] == 2
        assert body["result"]["mock"] is True
        assert body["metadata"]["mock"] is True
        assert body["confidence"] == 0.7

    def test_collection_resolution(self, fixture_provider):
        body = _post_search({
            "collection": "landsat-c2-l2",
            "dateRange": {"start": "2025-01-01", "end": "2025-12-31"},
            "aoi": AOI,
        }).json()
        assert body["result"]["collection"] == "landsat-c2-l2"
        assert body["result"]["collectionName"]
        assert body["result"]["count"] >= 1

    def test_unsupported_collection_fails(self, fixture_provider):
        body = _post_search({
            "sensor": "modis",
            "dateRange": {"start": "2025-01-01", "end": "2025-02-01"},
            "aoi": AOI,
        }).json()
        assert body["status"] == "failed"
        assert body["confidence"] == 0.0
        assert "Unsupported" in body["result"]["error"]

    def test_invalid_aoi_fails(self, fixture_provider):
        body = _post_search({
            "sensor": "sentinel-2",
            "dateRange": {"start": "2025-01-01", "end": "2025-02-01"},
            "aoi": {"type": "Point", "coordinates": [0, 0]},
        }).json()
        assert body["status"] == "failed"
        assert body["confidence"] == 0.0

    def test_bad_dates_fail(self, fixture_provider):
        body = _post_search({
            "sensor": "sentinel-2",
            "dateRange": {"start": "2025-06-01", "end": "2025-01-01"},
            "aoi": AOI,
        }).json()
        assert body["status"] == "failed"

    def test_offline_fails_clearly(self, offline_provider):
        body = _post_search({
            "sensor": "sentinel-2",
            "dateRange": {"start": "2025-01-01", "end": "2025-02-01"},
            "aoi": AOI,
        }).json()
        assert body["status"] == "failed"
        assert body["confidence"] == 0.0
        assert "No live satellite provider" in body["result"]["error"]

    def test_no_nan(self, fixture_provider):
        body = _post_search({
            "sensor": "sentinel-2",
            "dateRange": {"start": "2025-01-01", "end": "2025-12-31"},
            "aoi": AOI,
        }).json()
        assert "NaN" not in json.dumps(body)


# --------------------------------------------------------------------------- #
# API-level: /stac/ingest                                                      #
# --------------------------------------------------------------------------- #


class TestIngestApi:
    def test_ingest_success(self, fixture_provider, monkeypatch, tmp_path):
        monkeypatch.setenv("ACQUISITION_DIR", str(tmp_path))
        res = _post_ingest({
            "collection": "sentinel-2-l2a",
            "sceneId": "fixture-s2a-20250301",
            "aoi": AOI,
        })
        assert res.status_code == 200
        body = res.json()
        assert body["tool"] == "stac-ingest"
        assert body["status"] == "success"
        r = body["result"]
        assert r["sceneId"] == "fixture-s2a-20250301"
        assert r["mock"] is True
        assert r["analysis"]["crs"] == "EPSG:32643"
        assert r["preview"] is not None
        assert r["dedupeKey"].startswith("stac:stac-fixture:")
        assert r["validation"]["valid"] is True
        assert body["confidence"] == 0.7

    def test_ingest_missing_fields_rejected(self):
        assert _post_ingest({}).status_code == 422
        assert _post_ingest({"sceneId": "x", "aoi": AOI}).status_code == 422
        assert _post_ingest({"collection": "sentinel-2-l2a", "aoi": AOI}).status_code == 422

    def test_ingest_offline_fails(self, offline_provider):
        body = _post_ingest({
            "collection": "sentinel-2-l2a",
            "sceneId": "fixture-s2a-20250301",
            "aoi": AOI,
        }).json()
        assert body["status"] == "failed"
        assert body["confidence"] == 0.0

    def test_ingest_missing_scene_fails(self, fixture_provider):
        body = _post_ingest({
            "collection": "sentinel-2-l2a",
            "sceneId": "not-a-scene",
            "aoi": AOI,
        }).json()
        assert body["status"] == "failed"
        assert "known fixture" in body["result"]["error"]

    def test_ingest_no_nan(self, fixture_provider, monkeypatch, tmp_path):
        monkeypatch.setenv("ACQUISITION_DIR", str(tmp_path))
        body = _post_ingest({
            "collection": "sentinel-2-l2a",
            "sceneId": "fixture-s2a-20250301",
            "aoi": AOI,
        }).json()
        assert "NaN" not in json.dumps(body)
        assert "Infinity" not in json.dumps(body)


# --------------------------------------------------------------------------- #
# Item normalization (regression: role collisions on real catalogs)             #
# --------------------------------------------------------------------------- #


class _Item:
    """Minimal stand-in for a pystac Item (dict-based assets)."""

    def __init__(self, assets):
        self.id = "TEST-ITEM"
        self.properties = {}
        self.bbox = [700000.0, 2990000.0, 810000.0, 3100000.0]
        self.geometry = None
        self.assets = assets


def _asset(media_type, common_names):
    asset = {"href": f"https://example/{media_type}", "type": media_type}
    if common_names:
        asset["eo:bands"] = [{"common_name": cn} for cn in common_names]
    return asset


def _normalized(assets):
    return StacSatelliteProvider._normalize_item(
        _Item(assets), SENTINEL_2_L2A, "stac"
    )


class TestNormalizeItem:
    def test_prefers_cloud_optimized_tiff_over_jp2_for_same_role(self):
        # Legacy '-jp2' bands list the same common name as the COG family;
        # the COG image/tiff asset must stay authoritative regardless of order.
        scene = _normalized({
            "red-jp2": _asset("image/jp2", ["red"]),      # legacy, s3:// style
            "red": _asset("image/tiff; application=geotiff; profile=cloud-optimized", ["red"]),
        })
        assert scene.band_roles["red"] == "red"

    def test_cog_wins_even_when_listed_after_legacy(self):
        scene = _normalized({
            "red": _asset("image/tiff; application=geotiff; profile=cloud-optimized", ["red"]),
            "red-jp2": _asset("image/jp2", ["red"]),
        })
        assert scene.band_roles["red"] == "red"

    def test_composite_asset_never_registered_as_analysis_band(self):
        # 'visual' composites list red,green,blue together; they must not
        # hijack the red/green/blue roles.
        scene = _normalized({
            "visual": _asset("image/tiff; application=geotiff; profile=cloud-optimized", ["red", "green", "blue"]),
            "red": _asset("image/tiff; application=geotiff; profile=cloud-optimized", ["red"]),
            "green": _asset("image/tiff; application=geotiff; profile=cloud-optimized", ["green"]),
            "blue": _asset("image/tiff; application=geotiff; profile=cloud-optimized", ["blue"]),
            "nir": _asset("image/tiff; application=geotiff; profile=cloud-optimized", ["nir"]),
        })
        assert scene.band_roles == {
            "red": "red", "green": "green", "blue": "blue", "nir": "nir"
        }
        visual = next(a for a in scene.assets if a.name == "visual")
        assert visual.role is None

    def test_registry_names_matched_even_without_common_names(self):
        # Bands with no eo:bands resolve through the verified asset-name registry.
        scene = _normalized({
            "red": _asset("image/tiff; application=geotiff; profile=cloud-optimized", []),
            "green": _asset("image/tiff; application=geotiff; profile=cloud-optimized", []),
            "blue": _asset("image/tiff; application=geotiff; profile=cloud-optimized", []),
            "nir": _asset("image/tiff; application=geotiff; profile=cloud-optimized", []),
        })
        assert scene.band_roles == {"red": "red", "green": "green", "blue": "blue", "nir": "nir"}