"""Tests for the /caption API endpoint.

Captioning depends on real VLM inference (PyTorch + Qwen2-VL weights) which is
not always available in the test environment. These tests therefore exercise
the honest offline fallback: when caption inference is unavailable the endpoint
must return a clearly-labelled placeholder (metadata.mock=True), never invent a
caption or leak filesystem paths.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app.models.vlm_loader as vlm_loader
from app.main import app
from app.models.vlm_loader import VLMUnavailableError

client = TestClient(app)


def _post(image):
    with open(image, "rb") as f:
        return client.post(
            "/caption",
            files={"image": (image.name, f, "image/png")},
        )


def test_caption_imports_available():
    assert hasattr(vlm_loader, "DEFAULT_MODEL")
    assert hasattr(vlm_loader, "DEFAULT_CAPTION_MODEL")
    assert vlm_loader.DEFAULT_CAPTION_MODEL == vlm_loader.DEFAULT_MODEL
    assert issubclass(VLMUnavailableError, RuntimeError)


def test_caption_offline_mock_when_vlm_unavailable(plain_png, monkeypatch):
    def _raise(*args, **kwargs):
        raise VLMUnavailableError("torch missing")

    monkeypatch.setattr("app.tools.caption.run_caption", _raise)

    res = _post(plain_png)
    assert res.status_code == 200
    body = res.json()
    assert body["tool"] == "caption"
    assert body["status"] == "success"
    assert body["confidence"] == 0.0
    assert body["metadata"]["mock"] is True
    assert body["metadata"]["offline"] is True
    assert "torch missing" in body["metadata"]["reason"]
    assert body["result"]["caption"] == "offline-placeholder"


def test_caption_offline_mock_does_not_claim_analysis(plain_png, monkeypatch):
    def _raise(*args, **kwargs):
        raise VLMUnavailableError("weights missing")

    monkeypatch.setattr("app.tools.caption.run_caption", _raise)

    res = _post(plain_png)
    note = res.json()["metadata"]["note"]
    assert "offline" in note.lower()
    assert "not a model result" in note.lower()


def test_caption_missing_image_file():
    res = client.post("/caption")
    assert res.status_code == 422


def test_caption_unsupported_extension():
    res = client.post(
        "/caption",
        files={"image": ("data.txt", b"x", "text/plain")},
    )
    assert res.status_code == 200
    assert res.json()["status"] == "failed"


def test_caption_metadata_model_matches_constant(plain_png, monkeypatch):
    def _raise(*args, **kwargs):
        raise VLMUnavailableError("torch missing")

    monkeypatch.setattr("app.tools.caption.run_caption", _raise)

    res = _post(plain_png)
    assert res.json()["metadata"]["model"] == vlm_loader.DEFAULT_CAPTION_MODEL