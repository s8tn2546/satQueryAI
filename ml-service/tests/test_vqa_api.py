"""Tests for the /vqa API endpoint.

VQA depends on real VLM inference (PyTorch + Qwen2-VL weights) which is not
always available in the test environment. These tests therefore exercise the
honest offline fallback: when VLM inference is unavailable the endpoint must
return a clearly-labelled placeholder (metadata.mock=True), never invent facts
or leak filesystem paths, and still echo the question.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app.models.vlm_loader as vlm_loader
from app.main import app
from app.models.vlm_loader import VLMUnavailableError

client = TestClient(app)


def _post(image, question="Is there water?"):
    with open(image, "rb") as f:
        return client.post(
            "/vqa",
            files={"image": (image.name, f, "image/png")},
            data={"question": question},
        )


def test_vqa_imports_available():
    assert hasattr(vlm_loader, "DEFAULT_MODEL")
    assert hasattr(vlm_loader, "DEFAULT_VQA_MODEL")
    assert vlm_loader.DEFAULT_VQA_MODEL == vlm_loader.DEFAULT_MODEL
    assert issubclass(VLMUnavailableError, RuntimeError)


def test_vqa_offline_mock_when_vlm_unavailable(plain_png, monkeypatch):
    def _raise(*args, **kwargs):
        raise VLMUnavailableError("torch missing")

    monkeypatch.setattr("app.tools.vqa.run_vqa", _raise)

    res = _post(plain_png, question="Are there buildings?")
    assert res.status_code == 200
    body = res.json()
    assert body["tool"] == "vqa"
    assert body["status"] == "success"
    assert body["confidence"] == 0.0
    assert body["metadata"]["mock"] is True
    assert body["metadata"]["offline"] is True
    assert "torch missing" in body["metadata"]["reason"]
    assert body["result"]["question"] == "Are there buildings?"
    assert body["result"]["answer"] == "offline-placeholder"
    assert body["evidence"]["question"] == "Are there buildings?"


def test_vqa_offline_mock_does_not_claim_analysis(plain_png, monkeypatch):
    def _raise(*args, **kwargs):
        raise VLMUnavailableError("weights missing")

    monkeypatch.setattr("app.tools.vqa.run_vqa", _raise)

    res = _post(plain_png, question="Is there a lake?")
    note = res.json()["metadata"]["note"]
    assert "offline" in note.lower()
    assert "not a model result" in note.lower()


def test_vqa_missing_question(plain_png):
    with open(plain_png, "rb") as f:
        res = client.post(
            "/vqa",
            files={"image": (plain_png.name, f, "image/png")},
            data={"question": "   "},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "failed"
    assert body["confidence"] == 0.0


def test_vqa_missing_image_file():
    res = client.post("/vqa", data={"question": "Is there water?"})
    assert res.status_code == 422


def test_vqa_unsupported_extension():
    res = client.post(
        "/vqa",
        files={"image": ("data.txt", b"x", "text/plain")},
        data={"question": "Is there water?"},
    )
    assert res.status_code == 200
    assert res.json()["status"] == "failed"


def test_vqa_metadata_model_matches_constant(plain_png, monkeypatch):
    def _raise(*args, **kwargs):
        raise VLMUnavailableError("torch missing")

    monkeypatch.setattr("app.tools.vqa.run_vqa", _raise)

    res = _post(plain_png)
    assert res.json()["metadata"]["model"] == vlm_loader.DEFAULT_VQA_MODEL