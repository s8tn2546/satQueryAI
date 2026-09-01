"""Tests for the /optical-sar HTTP endpoint (app/api/optical_sar.py)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _post(optical, sar, **data):
    with open(optical, "rb") as f1, open(sar, "rb") as f2:
        files = {
            "optical_image": ("optical.tif", f1, "image/tiff"),
            "sar_image": ("sar.tif", f2, "image/tiff"),
        }
        return client.post("/optical-sar", files=files, data=data)


def test_success_schema(fusion_paired_rasters):
    optical, sar = fusion_paired_rasters
    res = _post(optical, sar)
    assert res.status_code == 200
    body = res.json()
    assert set(body.keys()) == {"tool", "status", "result", "evidence", "confidence", "metadata"}
    assert body["tool"] == "optical-sar"
    assert body["status"] == "success"
    assert body["result"]["overlap"]["valid_pixels"] == 100
    assert body["confidence"] == 1.0
    assert body["evidence"]["optical_image"]["filename"] == "optical.tif"
    assert body["evidence"]["sar_image"]["filename"] == "sar.tif"


def test_failure_schema(fusion_nonoverlap_pair):
    optical, sar = fusion_nonoverlap_pair
    res = _post(optical, sar)
    assert res.status_code == 200
    body = res.json()
    assert set(body.keys()) == {"tool", "status", "result", "evidence", "confidence", "metadata"}
    assert body["tool"] == "optical-sar"
    assert body["status"] == "failed"
    assert body["confidence"] == 0.0
    assert "error" in body["result"]


def test_missing_optical(sar_like_raster):
    with open(sar_like_raster, "rb") as f:
        res = client.post(
            "/optical-sar",
            files={"sar_image": ("sar.tif", f, "image/tiff")},
        )
    assert res.status_code == 422


def test_missing_sar(multiband_raster):
    with open(multiband_raster, "rb") as f:
        res = client.post(
            "/optical-sar",
            files={"optical_image": ("optical.tif", f, "image/tiff")},
        )
    assert res.status_code == 422


def test_missing_both_images():
    res = client.post("/optical-sar")
    assert res.status_code == 422


def test_invalid_raster(multiband_raster, corrupt_file):
    with open(multiband_raster, "rb") as f1, open(corrupt_file, "rb") as f2:
        res = client.post(
            "/optical-sar",
            files={
                "optical_image": ("optical.tif", f1, "image/tiff"),
                "sar_image": ("bad.tif", f2, "image/tiff"),
            },
        )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "failed"
    assert body["confidence"] == 0.0


def test_unsupported_extension(multiband_raster):
    with open(multiband_raster, "rb") as f:
        res = client.post(
            "/optical-sar",
            files={
                "optical_image": ("optical.tif", f, "image/tiff"),
                "sar_image": ("data.txt", b"text", "text/plain"),
            },
        )
    assert res.status_code == 200
    assert res.json()["status"] == "failed"


def test_invalid_band_params(fusion_paired_rasters):
    optical, sar = fusion_paired_rasters
    assert _post(optical, sar, optical_band="0").json()["status"] == "failed"
    assert _post(optical, sar, sar_band="-3").json()["status"] == "failed"
    assert _post(optical, sar, speckle_size="2").json()["status"] == "failed"


def test_confidence_deterministic(fusion_paired_rasters, fusion_nonoverlap_pair):
    optical, sar = fusion_paired_rasters
    assert _post(optical, sar).json()["confidence"] == 1.0
    assert _post(optical, sar).json()["confidence"] == 1.0
    o2, s2 = fusion_nonoverlap_pair
    assert _post(o2, s2).json()["confidence"] == 0.0
