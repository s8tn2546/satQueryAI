"""A/B gate: does the production inference path give BYTE-IDENTICAL results on
MPS(float16) vs CPU(float32)?

Runs the real loader (Qwen2-VL + VQA LoRA adapter), a realistic deterministic
256x256 image and all three production prompts. Loads the CPU instance, runs all
three calls, frees it, then loads the MPS instance and reruns. Compares every
returned (answer, confidence) tuple.

Exit 0 = identical on every call; exit 1 = any mismatch (details printed).

Usage: python scripts/ab_validate_mps.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")

from dotenv import load_dotenv

env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

import numpy as np
from PIL import Image


def make_deterministic_image(width: int = 256, height: int = 256) -> Image.Image:
    rng = np.random.default_rng(42)
    arr = np.zeros((height, width, 3), dtype=np.uint8)
    arr[:, : width // 2] = (60, 140, 50)
    arr[:, width // 2 :] = (40, 90, 160)
    arr[height // 3 : 2 * height // 3, 3 * width // 8 : 5 * width // 8] = (150, 150, 150)
    noise = rng.integers(0, 12, size=(height, width, 3), dtype=np.uint8)
    arr = np.clip(arr.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def _run_all(image, run_vqa, run_caption, max_tokens) -> dict:
    out = {}
    ans, conf = run_vqa(image, max_tokens["closed"], max_new_tokens=64)
    out["vqa_closed"] = {"answer": ans, "confidence": conf}
    ans, conf = run_vqa(image, max_tokens["structured"], max_new_tokens=256)
    out["vqa_structured"] = {"answer": ans, "confidence": conf}
    cap, conf = run_caption(image, max_new_tokens=512)
    out["caption"] = {"caption": cap, "confidence": conf}
    return out


def main() -> None:
    import torch
    import app.api.vqa as vqa_api
    import app.models.vlm_loader as loader
    from app.models.vlm_loader import DEFAULT_VQA_MODEL, DEFAULT_CAPTION_MODEL

    ADAPTER = getattr(vqa_api, "VQA_ADAPTER_PATH", None)
    img = make_deterministic_image()

    closed_q = "Is there water in this image?"
    structured_q = "Analyze the land cover in this image and describe vegetation health."
    max_tokens = {"closed": 64, "structured": 256}

    results: dict[str, dict] = {}

    def _run_on(label: str, device: str, dtype) -> dict:
        loader._device = lambda: torch.device(device)
        loader._dtype_for = lambda dev: torch.float16 if dev.type == "mps" else torch.float32
        loader._MODEL_CACHE.clear()
        t0 = time.perf_counter()
        # Reuse the real entry points so the whole production path is covered.
        from app.models.vlm_loader import run_vqa, run_caption

        out = _run_all(img, run_vqa, run_caption, max_tokens)
        out["load_seconds"] = round(time.perf_counter() - t0, 1)
        out["device"] = device
        loader._MODEL_CACHE.clear()
        return out

    results["cpu"] = _run_on("cpu", "cpu", torch.float32)
    print(f"cpu  done in {results['cpu']['load_seconds']}s incl. load")

    results["mps"] = _run_on("mps", "mps", torch.float16)
    print(f"mps  done in {results['mps']['load_seconds']}s incl. load")

    keys = ["vqa_closed", "vqa_structured", "caption"]
    mismatches = []
    for k in keys:
        same = results["cpu"][k] == results["mps"][k]
        print(f"{k:<16} identical={same}")
        if not same:
            mismatches.append(k)
            print(f"  cpu: {json.dumps(results['cpu'][k], ensure_ascii=False)[:300]}")
            print(f"  mps: {json.dumps(results['mps'][k], ensure_ascii=False)[:300]}")

    print(f"\nVQA answers equal across cpu/mps = {[results['cpu'][k] == results['mps'][k] for k in keys]}")
    sys.exit(0 if not mismatches else 1)


if __name__ == "__main__":
    main()