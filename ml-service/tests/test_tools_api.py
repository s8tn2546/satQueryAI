"""Tests for the /ndvi, /ndwi and /area API endpoints."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_ndvi_endpoint_success(multiband_raster):
    with open(multiband_raster, "rb") as f:
        res = client.post(
            "/ndvi",
            files={"file": ("m.tif", f, "image/tiff")},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["tool"] == "ndvi"
    assert body["status"] == "success"
    assert body["result"]["mean"] == pytest.approx(0.6, abs=1e-6)
    assert body["confidence"] == 1.0


def test_ndwi_endpoint_success(multiband_raster):
    with open(multiband_raster, "rb") as f:
        res = client.post(
            "/ndwi",
            files={"file": ("m.tif", f, "image/tiff")},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["tool"] == "ndwi"
    assert body["status"] == "success"
    assert body["result"]["mean"] == pytest.approx(-1 / 3, abs=1e-6)


def test_ndvi_endpoint_unlabeled_fails(unlabeled_multiband_raster):
    with open(unlabeled_multiband_raster, "rb") as f:
        res = client.post(
            "/ndvi",
            files={"file": ("u.tif", f, "image/tiff")},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "failure"
    assert "could not be identified" in body["result"]["error"]
    assert body["confidence"] == 0.0


def test_ndvi_endpoint_unsupported_extension():
    res = client.post(
        "/ndvi",
        files={"file": ("data.txt", b"x", "text/plain")},
    )
    assert res.status_code == 200
    assert res.json()["status"] == "failure"


def test_ndvi_endpoint_missing_file():
    res = client.post("/ndvi")
    assert res.status_code == 422


def test_ndwi_endpoint_band_overrides(ndvi_ndwi_raster):
    with open(ndvi_ndwi_raster, "rb") as f:
        res = client.post(
            "/ndwi",
            files={"file": ("n.tif", f, "image/tiff")},
            data={"green_band": "2", "nir_band": "3"},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "success"
    assert body["result"]["bands"]["green"] == "Band 2"
    assert body["result"]["bands"]["nir"] == "Band 3"
    assert body["result"]["mean"] == pytest.approx(-240 / 760, abs=1e-6)


def test_area_endpoint_success(nodata_raster):
    with open(nodata_raster, "rb") as f:
        res = client.post(
            "/area",
            files={"file": ("a.tif", f, "image/tiff")},
            data={"feature_type": "lake"},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["tool"] == "area"
    assert body["status"] == "success"
    assert body["result"]["feature_type"] == "lake"
    assert body["result"]["area_m2"] == pytest.approx(3600.0, abs=0.01)
    assert body["result"]["area_km2"] == pytest.approx(0.0036, abs=1e-6)


def test_area_endpoint_geographic_failure(geographic_raster):
    with open(geographic_raster, "rb") as f:
        res = client.post(
            "/area",
            files={"file": ("geo.tif", f, "image/tiff")},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "failure"
    assert "geographic" in body["result"]["error"].lower()
    assert "EPSG:4326" in body["result"]["crs"]
