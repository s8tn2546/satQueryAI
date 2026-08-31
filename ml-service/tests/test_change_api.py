"""Tests for the /change HTTP endpoint (app/api/change.py)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _post(p1, p2, **data):
    with open(p1, "rb") as f1, open(p2, "rb") as f2:
        files = {
            "image1": ("img1.tif", f1, "image/tiff"),
            "image2": ("img2.tif", f2, "image/tiff"),
        }
        return client.post("/change", files=files, data=data)


def test_change_success_schema(change_known_pair):
    p1, p2 = change_known_pair
    res = _post(p1, p2, threshold="50")
    assert res.status_code == 200
    body = res.json()
    assert set(body.keys()) == {"tool", "status", "result", "evidence", "confidence", "metadata"}
    assert body["tool"] == "change"
    assert body["status"] == "success"
    assert body["result"]["changed_pixels"] == 9
    assert body["result"]["change_percentage"] == pytest.approx(9.0, abs=1e-6)
    assert body["confidence"] == 1.0
    assert body["evidence"]["image1"]["filename"] == "img1.tif"
    assert body["evidence"]["image2"]["filename"] == "img2.tif"


def test_change_failure_schema(change_nonoverlap_pair):
    p1, p2 = change_nonoverlap_pair
    res = _post(p1, p2)
    assert res.status_code == 200
    body = res.json()
    assert set(body.keys()) == {"tool", "status", "result", "evidence", "confidence", "metadata"}
    assert body["tool"] == "change"
    assert body["status"] == "failure"
    assert body["confidence"] == 0.0
    assert "error" in body["result"]


def test_change_missing_image1(georeferenced_raster):
    with open(georeferenced_raster, "rb") as f:
        res = client.post(
            "/change",
            files={"image2": ("img2.tif", f, "image/tiff")},
        )
    assert res.status_code == 422


def test_change_missing_image2(georeferenced_raster):
    with open(georeferenced_raster, "rb") as f:
        res = client.post(
            "/change",
            files={"image1": ("img1.tif", f, "image/tiff")},
        )
    assert res.status_code == 422


def test_change_missing_both_images():
    res = client.post("/change")
    assert res.status_code == 422


def test_change_invalid_raster(georeferenced_raster, corrupt_file):
    with open(georeferenced_raster, "rb") as f1, open(corrupt_file, "rb") as f2:
        res = client.post(
            "/change",
            files={
                "image1": ("img1.tif", f1, "image/tiff"),
                "image2": ("bad.tif", f2, "image/tiff"),
            },
        )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "failure"
    assert body["confidence"] == 0.0


def test_change_unsupported_extension(georeferenced_raster):
    with open(georeferenced_raster, "rb") as f:
        res = client.post(
            "/change",
            files={
                "image1": ("img1.tif", f, "image/tiff"),
                "image2": ("data.txt", b"text", "text/plain"),
            },
        )
    assert res.status_code == 200
    assert res.json()["status"] == "failure"


def test_change_invalid_threshold(change_known_pair):
    p1, p2 = change_known_pair
    res = _post(p1, p2, threshold="-5")
    assert res.status_code == 200
    assert res.json()["status"] == "failure"
    assert res.json()["confidence"] == 0.0


def test_change_confidence_deterministic(change_identical_pair, change_nonoverlap_pair):
    p1, p2 = change_identical_pair
    body = _post(p1, p2).json()
    assert body["confidence"] == 1.0
    # Same request again -> same confidence
    assert _post(p1, p2).json()["confidence"] == 1.0

    p3, p4 = change_nonoverlap_pair
    assert _post(p3, p4).json()["confidence"] == 0.0
