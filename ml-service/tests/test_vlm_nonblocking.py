"""Phase 18: VLM non-blocking + thread-safety regression tests.

These tests verify, WITHOUT loading the real model:

1. Endpoints run the heavy synchronous compute off the event loop
   (``asyncio.to_thread``): the worker thread differs from the event-loop
   thread, and the loop stays responsive (a slow /vqa never stalls /health).
2. Exceptions raised inside the worker thread propagate to the endpoint's
   error handling instead of leaking as server errors.
3. ``load_qwen_model`` is single-flight: N concurrent first loaders build
   exactly one instance and all receive the same cached instance.
4. Inference is serialized by ``_INFERENCE_LOCK``: concurrent ``run_vqa`` /
   ``run_caption`` calls never run ``generate`` at the same time.

The real-model equivalence (CPU float32 vs MPS fp16) is validated separately by
``scripts/ab_validate_mps.py``; see docs/08_PHASE18... .
"""

from __future__ import annotations

import threading
import time

import pytest
import torch
from fastapi.testclient import TestClient
from peft import PeftModel

import app.models.vlm_loader as vlm_loader
from app.main import app
from app.models.vlm_loader import VLMUnavailableError
from app.tools.vqa import VQAError

client = TestClient(app)

_STATE_LOCK = threading.Lock()
_STATE = {"active": 0, "max_active": 0, "build_calls": 0}


def _reset_state() -> None:
    with _STATE_LOCK:
        _STATE["active"] = 0
        _STATE["max_active"] = 0
        _STATE["build_calls"] = 0


class _Param:
    device = torch.device("cpu")


class _FakeResults(dict):
    """Dict-like processor output: splats into generate(**inputs) and exposes
    ``.input_ids`` for the token-count slicing."""

    def __init__(self, input_len: int = 4) -> None:
        ids = torch.arange(input_len, dtype=torch.long).unsqueeze(0)
        super().__init__(input_ids=ids, attention_mask=torch.ones(1, input_len, dtype=torch.long))
        self.input_ids = ids

    def to(self, device):
        return self


class _FakeModel:
    decode_text = "yes"

    def __init__(self) -> None:
        self._param = _Param()

    def parameters(self):
        yield self._param

    def eval(self) -> None:
        pass

    def generate(self, **inputs):
        with _STATE_LOCK:
            _STATE["active"] += 1
            _STATE["max_active"] = max(_STATE["max_active"], _STATE["active"])
        # Widen the race window so a missing inference lock would be detected.
        time.sleep(0.02)
        with _STATE_LOCK:
            _STATE["active"] -= 1
        input_len = inputs["input_ids"].shape[1]
        max_new = inputs.get("max_new_tokens", 8) or 8
        return torch.arange(input_len + max_new, dtype=torch.long).unsqueeze(0)


class _FakeProcessor:
    def __init__(self, model: _FakeModel) -> None:
        self._model = model

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=True):
        return "chat"

    def __call__(self, text=None, images=None, videos=None, padding=False, return_tensors=None):
        return _FakeResults()

    def batch_decode(self, ids, skip_special_tokens=False):
        return [self._model.decode_text]


class _FakePeft(PeftModel):
    pass


@pytest.fixture(autouse=True)
def _clean_cache(monkeypatch):
    """Every test in this module runs against a controlled fake world: clear the
    shared model cache and stub the model-build seam so nothing touches disk."""
    _reset_state()
    vlm_loader._MODEL_CACHE.clear()
    monkeypatch.setattr(
        vlm_loader, "_import_vision_utils", lambda: (lambda messages: ([], []))
    )
    yield
    vlm_loader._MODEL_CACHE.clear()


# --------------------------------------------------------------------------- #
# Endpoint: compute runs off the event loop
# --------------------------------------------------------------------------- #


def _upload(tmp_dir, content=b"\x00\x01\x02"):
    upload_path = tmp_dir / "test.png"
    upload_path.write_bytes(content)
    with open(upload_path, "rb") as f:
        return client.post(
            "/vqa",
            files={"image": ("test.png", f, "image/png")},
            data={"question": "Is there water?"},
        )


def test_vqa_compute_runs_on_worker_thread_not_event_loop(tmp_path, monkeypatch):
    threads: dict[str, int] = {}

    async def fake_read_upload_file(upload):
        threads["loop"] = threading.get_ident()
        return b"fake-png-bytes"

    def fake_compute(tmp_path, question, adapter_path=None, aoi=None, aoi_crs=None):
        # Sleep briefly; a scheduler hiccup is fine, the assertion is the thread id.
        time.sleep(0.01)
        threads["compute"] = threading.get_ident()
        return {"answer": "yes", "question": question, "confidence": 0.8}

    monkeypatch.setattr("app.api.vqa.read_upload_file", fake_read_upload_file)

    def _patched_compute(*a, **k):
        return fake_compute(*a, **k)

    monkeypatch.setattr("app.api.vqa.compute_vqa", _patched_compute)

    res = _upload(tmp_path)
    assert res.status_code == 200
    assert res.json()["result"]["answer"] == "yes"
    assert "loop" in threads and "compute" in threads
    assert threads["compute"] != threads["loop"], (
        "compute_vqa ran on the event-loop thread; expected asyncio.to_thread"
    )


def test_caption_compute_runs_on_worker_thread_not_event_loop(tmp_path, monkeypatch):
    threads: dict[str, int] = {}

    async def fake_read_upload_file(upload):
        threads["loop"] = threading.get_ident()
        return b"fake-png-bytes"

    def fake_compute(tmp_path, adapter_path=None, aoi=None, aoi_crs=None):
        time.sleep(0.01)
        threads["compute"] = threading.get_ident()
        return {"caption": "A farm field.", "confidence": 0.7}

    monkeypatch.setattr("app.api.caption.read_upload_file", fake_read_upload_file)
    monkeypatch.setattr("app.api.caption.compute_caption", fake_compute)

    upload_path = tmp_path / "test.png"
    upload_path.write_bytes(b"\x00\x01\x02")
    with open(upload_path, "rb") as f:
        res = client.post(
            "/caption",
            files={"image": ("test.png", f, "image/png")},
        )
    assert res.status_code == 200
    assert res.json()["result"]["caption"] == "A farm field."
    assert threads["compute"] != threads["loop"], (
        "compute_caption ran on the event-loop thread; expected asyncio.to_thread"
    )


def test_health_stays_responsive_while_vqa_compute_blocks(tmp_path, monkeypatch):
    started = threading.Event()
    release = threading.Event()

    async def fake_read_upload_file(upload):
        return b"fake-png-bytes"

    def slow_compute(tmp_path, question, adapter_path=None, aoi=None, aoi_crs=None):
        started.set()
        assert release.wait(timeout=10)
        return {"answer": "no", "question": question, "confidence": 0.8}

    monkeypatch.setattr("app.api.vqa.read_upload_file", fake_read_upload_file)
    monkeypatch.setattr("app.api.vqa.compute_vqa", slow_compute)

    outcome: dict[str, object] = {}

    def _post():
        outcome["res"] = _upload(tmp_path)
        outcome["status"] = None

    t = threading.Thread(target=_post)
    t.start()
    assert started.wait(timeout=10), "vqa compute never started"

    t0 = time.perf_counter()
    health = client.get("/health")
    elapsed = time.perf_counter() - t0
    release.set()
    t.join(timeout=15)

    assert health.status_code == 200, "event loop was blocked by VLM compute"
    assert elapsed < 1.0, f"/health took {elapsed:.2f}s while /vqa computed"


# --------------------------------------------------------------------------- #
# Endpoint: worker-thread exceptions reach error handling
# --------------------------------------------------------------------------- #


def test_vqa_worker_exception_becomes_failed_response(tmp_path, monkeypatch):
    async def fake_read_upload_file(upload):
        return b"fake-png-bytes"

    def boom(*args, **kwargs):
        raise VQAError("adapter exploded")

    monkeypatch.setattr("app.api.vqa.read_upload_file", fake_read_upload_file)
    monkeypatch.setattr("app.api.vqa.compute_vqa", boom)

    res = _upload(tmp_path)
    assert res.status_code == 200
    assert res.json()["status"] == "failed"
    assert "adapter exploded" in res.json()["result"]["error"]


def test_vqa_worker_unexpected_error_surfaced_as_internal(tmp_path, monkeypatch):
    async def fake_read_upload_file(upload):
        return b"fake-png-bytes"

    def boom(*args, **kwargs):
        raise RuntimeError("weird bug")

    monkeypatch.setattr("app.api.vqa.read_upload_file", fake_read_upload_file)
    monkeypatch.setattr("app.api.vqa.compute_vqa", boom)

    res = _upload(tmp_path)
    assert res.status_code == 200
    assert res.json()["status"] == "failed"
    assert "Internal error" in res.json()["result"]["error"]


# --------------------------------------------------------------------------- #
# Loader: single-flight load + inference serialization
# --------------------------------------------------------------------------- #


def test_load_is_single_flight(monkeypatch):
    model, processor = _FakeModel(), _FakeProcessor(_FakeModel())
    frames = {"build_calls_seen": int()}

    def _build(model_name, adapter_path):
        with _STATE_LOCK:
            _STATE["build_calls"] += 1
            frames["build_calls_seen"] = _STATE["build_calls"]
        time.sleep(0.1)
        return model, processor

    monkeypatch.setattr(vlm_loader, "_build_qwen_model", _build)
    vlm_loader._MODEL_CACHE.clear()

    results: list[object] = []
    results_lock = threading.Lock()

    def _load():
        m, p = vlm_loader.load_qwen_model("m", "ad")
        with results_lock:
            results.append(m)

    threads = [threading.Thread(target=_load) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    assert _STATE["build_calls"] == 1, "concurrent loaders built duplicate models"
    assert all(r is model for r in results), "callers did not all get the cached instance"


def test_inference_serialized_by_lock(monkeypatch):
    model, processor = _FakeModel(), _FakeProcessor(_FakeModel())
    monkeypatch.setattr(
        vlm_loader, "_build_qwen_model",
        lambda name, adapter: (model, processor),
    )
    vlm_loader._MODEL_CACHE.clear()

    answers: list[tuple[str, float]] = []
    answers_lock = threading.Lock()

    def _infer():
        ans = vlm_loader.run_vqa(
            _placeholder_image(), "Is there water?", max_new_tokens=8
        )
        with answers_lock:
            answers.append(ans)

    threads = [threading.Thread(target=_infer) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)

    assert len(answers) == 6
    assert _STATE["max_active"] == 1, f"max concurrent generate = {_STATE['max_active']}"


def test_caption_serialized_by_lock(monkeypatch):
    model = _FakeModel()
    model.decode_text = "A farm field with a river."
    processor = _FakeProcessor(model)
    monkeypatch.setattr(
        vlm_loader, "_build_qwen_model",
        lambda name, adapter: (model, processor),
    )
    vlm_loader._MODEL_CACHE.clear()

    results: list[tuple[str, float]] = []
    results_lock = threading.Lock()

    def _infer():
        cap = vlm_loader.run_caption(_placeholder_image(), max_new_tokens=8)
        with results_lock:
            results.append(cap)

    threads = [threading.Thread(target=_infer) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)

    assert len(results) == 6
    assert _STATE["max_active"] == 1, f"max concurrent generate = {_STATE['max_active']}"


def _placeholder_image():
    from PIL import Image

    return Image.new("RGB", (64, 64), (40, 90, 160))


# --------------------------------------------------------------------------- #
# Warmup: schema preserved, offload keeps it non-fatal, caption warmed
# --------------------------------------------------------------------------- #


def test_warmup_reports_ok_and_adapter_active(monkeypatch):
    fake = _FakePeft.__new__(_FakePeft)

    def fake_load(model_name, adapter_path=None):
        return fake, _FakeProcessor(_FakeModel())

    monkeypatch.setattr("app.models.vlm_loader.load_qwen_model", fake_load)

    res = client.post("/vlm/warmup")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["adapter_active"] is True
    assert body["caption_model"] == vlm_loader.DEFAULT_CAPTION_MODEL


def test_warmup_unavailable_returns_unavailable(monkeypatch):
    def fake_load(model_name, adapter_path=None):
        raise VLMUnavailableError("no torch")

    monkeypatch.setattr("app.models.vlm_loader.load_qwen_model", fake_load)

    res = client.post("/vlm/warmup")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "unavailable"
    assert "no torch" in body["reason"]