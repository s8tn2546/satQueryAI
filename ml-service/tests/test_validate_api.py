"""Tests for the /validate API endpoint."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "satquery-ml"}


def test_validate_success(georeferenced_raster):
    with open(georeferenced_raster, "rb") as f:
        res = client.post(
            "/validate",
            files={"file": ("valid.tif", f, "image/tiff")},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["tool"] == "validate"
    assert body["status"] == "success"
    result = body["result"]
    assert result["valid"] is True
    assert result["validation_status"] == "valid"
    assert result["crs"] == "EPSG:32643"
    assert result["width"] == 10
    assert result["height"] == 10
    assert result["band_count"] == 1


def test_validate_unsupported_extension():
    res = client.post(
        "/validate",
        files={"file": ("data.txt", b"just some text", "text/plain")},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["result"]["valid"] is False
    assert body["result"]["validation_status"] == "invalid"
    assert any("Unsupported" in e for e in body["result"]["errors"])


def test_validate_missing_file():
    res = client.post("/validate")
    assert res.status_code == 422  # missing required field


def test_validate_corrupt_file(corrupt_file):
    with open(corrupt_file, "rb") as f:
        res = client.post(
            "/validate",
            files={"file": ("corrupt.tif", f, "image/tiff")},
        )
    assert res.status_code == 200
    assert res.json()["result"]["valid"] is False


def test_validate_modality_hint_optical(georeferenced_raster):
    with open(georeferenced_raster, "rb") as f:
        res = client.post(
            "/validate",
            files={"file": ("valid.tif", f, "image/tiff")},
            data={"modality_hint": "optical"},
        )
    assert res.status_code == 200
    assert res.json()["result"]["modality"] == "optical"


def test_validate_invalid_modality_hint(georeferenced_raster):
    with open(georeferenced_raster, "rb") as f:
        res = client.post(
            "/validate",
            files={"file": ("valid.tif", f, "image/tiff")},
            data={"modality_hint": "bogus"},
        )
    assert res.status_code == 200
    assert res.json()["result"]["valid"] is False


def test_validate_empty_file():
    res = client.post(
        "/validate",
        files={"file": ("empty.tif", b"", "image/tiff")},
    )
    assert res.status_code == 200
    assert res.json()["result"]["valid"] is False


def test_validate_multiband(georeferenced_raster):
    """Reuse a simple raster but verify band validation path runs."""
    with open(georeferenced_raster, "rb") as f:
        res = client.post(
            "/validate",
            files={"file": ("b.tif", f, "image/tiff")},
        )
    assert res.json()["result"]["valid"] is True
    assert res.json()["confidence"] >= 0.0


def test_validate_plain_png(plain_png):
    with open(plain_png, "rb") as f:
        res = client.post(
            "/validate",
            files={"file": ("plain.png", f, "image/png")},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["result"]["valid"] is True
    assert body["result"]["validation_status"] == "warning"  # no georef
    assert body["result"]["crs"] is None
