"""Tests for the /trend HTTP endpoint (app/api/trend.py)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.api.trend import resolve_provider
from app.main import app
from app.services.gee_client import GeeAuthError, MockGeeProvider
from app.tools.trend import TrendValidationError, compute_trend

client = TestClient(app)

REGION = {
    "type": "Polygon",
    "coordinates": [[[78.0, 28.0], [78.5, 28.0], [78.5, 28.5], [78.0, 28.5], [78.0, 28.0]]],
}


@pytest.fixture
def mock_provider():
    provider = MockGeeProvider()
    app.dependency_overrides[resolve_provider] = lambda: provider
    yield provider
    app.dependency_overrides.pop(resolve_provider, None)


@pytest.fixture
def auth_fail_provider():
    class _A:
        def __init__(self):
            import functools

            self.on = False
        def compute_trend(self, *a, **k):
            raise GeeAuthError("GEE credentials are not configured.")

    app.dependency_overrides[resolve_provider] = _A
    yield
    app.dependency_overrides.pop(resolve_provider, None)


def _post(payload):
    return client.post("/trend", json=payload)


def test_api_success_schema(mock_provider):
    res = _post({
        "region": REGION,
        "start_date": "2021-01-01",
        "end_date": "2021-06-01",
        "metric": "ndvi",
        "interval": "monthly",
    })
    assert res.status_code == 200
    body = res.json()
    assert set(body.keys()) == {"tool", "status", "result", "evidence", "confidence", "metadata"}
    assert body["tool"] == "trend"
    assert body["status"] == "success"
    assert body["result"]["series"]
    assert body["result"]["trend"]["slope"] is not None
    # Mock data is explicitly labelled, never presented as real GEE.
    assert body["metadata"]["data_source"] == "mock"
    assert body["evidence"]["data_source"] == "mock"
    assert body["confidence"] == 0.8


def test_api_validation_failure(mock_provider):
    res = _post({
        "region": {"type": "Point", "coordinates": [0, 0]},
        "start_date": "2021-01-01",
        "end_date": "2022-01-01",
        "metric": "ndvi",
    })
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "failed"
    assert body["confidence"] == 0.0
    assert "error" in body["result"]


def test_api_missing_fields():
    res = _post({})
    assert res.status_code == 422
    res2 = _post({"region": REGION, "start_date": "2021-01-01"})
    assert res2.status_code == 422


def test_api_unsupported_metric(mock_provider):
    res = _post({
        "region": REGION,
        "start_date": "2021-01-01",
        "end_date": "2022-01-01",
        "metric": "ndbi",
    })
    assert res.status_code == 200
    assert res.json()["status"] == "failed"
    assert res.json()["confidence"] == 0.0


def test_api_gee_unavailable_is_structured_failure(auth_fail_provider):
    res = _post({
        "region": REGION,
        "start_date": "2021-01-01",
        "end_date": "2022-01-01",
        "metric": "ndvi",
    })
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "failed"
    assert body["confidence"] == 0.0
    assert "error" in body["result"]
    assert "GEE" in body["result"]["error"] or "GEE" in body["result"]["error"]


def test_api_confidence_deterministic(mock_provider):
    payload = {
        "region": REGION,
        "start_date": "2021-01-01",
        "end_date": "2021-06-01",
        "metric": "ndvi",
    }
    assert _post(payload).json()["confidence"] == 0.8
    assert _post(payload).json()["confidence"] == 0.8


def test_api_default_metric_is_ndvi(mock_provider):
    # Omit metric -> backend default 'ndvi' flows through the schema default.
    res = _post({
        "region": REGION,
        "start_date": "2021-01-01",
        "end_date": "2021-03-01",
    })
    assert res.status_code == 200
    assert res.json()["result"]["metric"] == "ndvi"
