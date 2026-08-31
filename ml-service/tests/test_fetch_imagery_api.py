"""Tests for the /fetch-imagery HTTP endpoint (app/api/fetch_imagery.py)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.api.fetch_imagery import resolve_provider
from app.main import app
from app.services.gee_client import GeeAuthError, GeeQueryError, MockGeeProvider

client = TestClient(app)

REGION = {
    "type": "Polygon",
    "coordinates": [[[78.0, 28.0], [78.5, 28.0], [78.5, 28.5], [78.0, 28.5], [78.0, 28.0]]],
}


class _FakeRealProvider:
    """A fake 'real' GEE provider returning local GeoTIFF files (no network)."""

    def __init__(self, optical_path=None, sar_path=None, *, date_gap=2):
        self._optical = optical_path
        self._sar = sar_path
        self._date_gap = date_gap

    def fetch_pair(self, region, start, end, preferred_date=None):
        payload = {"source": "gee", "date_gap_days": self._date_gap,
                   "provider_warnings": []}
        if self._optical is not None:
            payload["optical"] = {
                "modality": "optical", "source": "sentinel-2",
                "satellite": "Sentinel-2", "collection": "COPERNICUS/S2_SR_HARMONIZED",
                "file_path": str(self._optical), "downloaded": True,
                "capture_date": "2021-03-01T00:00:00Z", "cloud_cover": 4.0,
                "resolution": 10, "crs": "EPSG:32643", "bounding_box": region,
                "bands": ["B2", "B3", "B4", "B8"], "product_id": "FAKE-S2",
            }
        if self._sar is not None:
            payload["sar"] = {
                "modality": "sar", "source": "sentinel-1",
                "satellite": "Sentinel-1", "collection": "COPERNICUS/S1_GRD",
                "file_path": str(self._sar), "downloaded": True,
                "capture_date": "2021-03-03T00:00:00Z",
                "polarization": ["VV", "VH"], "orbit": "DESCENDING",
                "resolution": 10, "crs": "EPSG:32643", "bounding_box": region,
                "bands": ["VV", "VH"], "product_id": "FAKE-S1",
            }
        return payload


@pytest.fixture
def mock_provider():
    provider = MockGeeProvider()
    app.dependency_overrides[resolve_provider] = lambda: provider
    yield provider
    app.dependency_overrides.pop(resolve_provider, None)


@pytest.fixture
def auth_fail_provider():
    class _A:
        def fetch_pair(self, *a, **k):
            raise GeeAuthError("GEE credentials are not configured.")

    app.dependency_overrides[resolve_provider] = _A
    yield
    app.dependency_overrides.pop(resolve_provider, None)


@pytest.fixture
def query_fail_provider():
    class _Q:
        def fetch_pair(self, *a, **k):
            raise GeeQueryError("GEE query failed.")

    app.dependency_overrides[resolve_provider] = _Q
    yield
    app.dependency_overrides.pop(resolve_provider, None)


def _post(payload):
    return client.post("/fetch-imagery", json=payload)


def test_api_success_schema(mock_provider):
    res = _post({"bounding_box": REGION})
    assert res.status_code == 200
    body = res.json()
    assert set(body.keys()) == {
        "tool", "status", "result", "evidence", "confidence", "metadata"
    }
    assert body["tool"] == "fetch-imagery"
    assert body["status"] == "success"
    images = body["result"]["images"]
    assert len(images) == 2
    modalities = {i["modality"] for i in images}
    assert {"optical", "sar"} == set(modalities)
    # Mock is explicitly labelled and never marked as real/downloaded.
    assert body["metadata"]["data_source"] == "mock"
    assert body["evidence"]["data_source"] == "mock"
    assert all(i["downloaded"] is False for i in images)
    assert all(i["filePath"] is None for i in images)
    assert body["confidence"] == 0.7


def test_api_sentinel2_metadata(mock_provider):
    body = _post({"bounding_box": REGION}).json()
    optical = next(i for i in body["result"]["images"] if i["modality"] == "optical")
    assert optical["source"] == "sentinel-2"
    assert optical["satellite"] == "Sentinel-2"
    assert "cloudCover" in optical


def test_api_sentinel1_metadata(mock_provider):
    body = _post({"bounding_box": REGION}).json()
    sar = next(i for i in body["result"]["images"] if i["modality"] == "sar")
    assert sar["source"] == "sentinel-1"
    assert sar["modality"] == "sar"
    assert sar["polarization"] == ["VV", "VH"]
    assert "orbit" in sar


def test_api_missing_fields():
    res = _post({})
    assert res.status_code == 422


def test_api_invalid_bbox(mock_provider):
    body = _post({"bounding_box": {"type": "Point", "coordinates": [0, 0]}}).json()
    assert body["status"] == "failed"
    assert body["confidence"] == 0.0
    assert "error" in body["result"]


def test_api_invalid_date(mock_provider):
    body = _post({
        "bounding_box": REGION,
        "start_date": "2022-01-01",
        "end_date": "2021-01-01",
    }).json()
    assert body["status"] == "failed"
    assert body["confidence"] == 0.0


def test_api_future_date(mock_provider):
    body = _post({
        "bounding_box": REGION,
        "start_date": "2020-01-01",
        "end_date": "2099-01-01",
    }).json()
    assert body["status"] == "failed"
    assert body["confidence"] == 0.0


def test_api_gee_unavailable_structured_failure(auth_fail_provider):
    body = _post({"bounding_box": REGION}).json()
    assert body["status"] == "failed"
    assert body["confidence"] == 0.0
    assert "GEE" in body["result"]["error"]


def test_api_gee_query_failure_structured_failure(query_fail_provider):
    body = _post({"bounding_box": REGION}).json()
    assert body["status"] == "failed"
    assert body["confidence"] == 0.0
    assert "error" in body["result"]


def test_api_real_validated_pair_high_confidence(georeferenced_raster):
    provider = _FakeRealProvider(
        optical_path=georeferenced_raster, sar_path=georeferenced_raster, date_gap=2
    )
    app.dependency_overrides[resolve_provider] = lambda: provider
    try:
        body = _post({"bounding_box": REGION}).json()
    finally:
        app.dependency_overrides.pop(resolve_provider, None)
    assert body["status"] == "success"
    assert body["metadata"]["data_source"] == "gee"
    assert body["result"]["date_gap_days"] == 2
    assert all(i["validated"] is True for i in body["result"]["images"])
    assert all(i["downloaded"] is True for i in body["result"]["images"])
    assert body["confidence"] == 1.0


def test_api_partial_single_image(georeferenced_raster):
    provider = _FakeRealProvider(optical_path=georeferenced_raster, sar_path=None)
    app.dependency_overrides[resolve_provider] = lambda: provider
    try:
        body = _post({"bounding_box": REGION}).json()
    finally:
        app.dependency_overrides.pop(resolve_provider, None)
    assert body["status"] == "partial"
    assert body["confidence"] == 0.5
    assert len(body["result"]["images"]) == 1


def test_api_confidence_deterministic(mock_provider):
    assert _post({"bounding_box": REGION}).json()["confidence"] == 0.7
    assert _post({"bounding_box": REGION}).json()["confidence"] == 0.7


def test_api_no_nan_infinity():
    body = _post({"bounding_box": REGION}).json()
    raw = str(body)
    assert "NaN" not in raw and "Infinity" not in raw
