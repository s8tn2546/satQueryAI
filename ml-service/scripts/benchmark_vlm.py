"""Reproducible VLM benchmark for the SatQuery ML service.

Measures, on the real Qwen2-VL stack as installed, without model edits:
  - cold model load (first load, includes adapter when VQA_ADAPTER_PATH is set)
  - warm inference: VQA closed (64-token budget), VQA structured (256),
    caption (512)
  - preprocessing (chat template + processor) and postprocessing (decode)
  - per-stage and total latency over a few repeated runs (mean + median)

Uses a deterministic synthetic test image so the same input can be re-run.

Usage:
    python scripts/benchmark_vlm.py [--runs N] [--skip-load]

The script never claims scientific accuracy; it only measures wall-clock
behaviour of the current stack.
"""

from __future__ import annotations

import argparse
import hashlib
import statistics
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image

# Honor .env (VLM_MODEL / VQA_ADAPTER_PATH) before importing the loader.
from dotenv import load_dotenv

env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

import app.api.vqa as vqa_api  # noqa: E402
import app.models.vlm_loader as loader  # noqa: E402
from app.models.vlm_loader import (  # noqa: E402
    DEFAULT_VQA_MODEL,
    _import_vision_utils,
    load_qwen_model,
    run_caption,
    run_vqa,
)

ADAPTER = getattr(vqa_api, "VQA_ADAPTER_PATH", None)


def make_deterministic_image(width: int = 256, height: int = 256) -> Image.Image:
    """Deterministic synthetic RGB image (green/water checker + urban block).

    Not a real satellite scene; purely a reproducible input for timing.
    """
    rng = np.random.default_rng(42)
    arr = np.zeros((height, width, 3), dtype=np.uint8)
    # Vegetation-ish left half, water-ish right half.
    arr[:, : width // 2] = (60, 140, 50)
    arr[:, width // 2 :] = (40, 90, 160)
    # A small urban-like block.
    arr[height // 3 : 2 * height // 3, 3 * width // 8 : 5 * width // 8] = (150, 150, 150)
    # Deterministic speckle.
    noise = rng.integers(0, 12, size=(height, width, 3), dtype=np.uint8)
    arr = np.clip(arr.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def _report(label: str, samples: list[float]) -> None:
    if not samples:
        print(f"{label:<42} no samples")
        return
    mean = statistics.mean(samples)
    med = statistics.median(samples)
    print(f"{label:<42} mean={mean:9.3f}s  median={med:9.3f}s  n={len(samples)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=2, help="warm runs per modality")
    parser.add_argument("--skip-load", action="store_true", help="skip cold-load timing")
    parser.add_argument(
        "--device",
        choices=("auto", "cpu", "mps"),
        default="auto",
        help="force the inference device (default auto = loader default: "
        "cuda -> mps -> cpu)",
    )
    args = parser.parse_args()

    if args.device != "auto":
        import torch

        if args.device == "cpu":
            loader._device = lambda: torch.device("cpu")
        else:
            loader._device = lambda: torch.device("mps")
        loader._dtype_for = (
            (lambda dev: torch.float16 if dev.type == "mps" else torch.float32)
            if args.device == "mps"
            else (lambda dev: torch.bfloat16 if dev.type == "cuda" else torch.float32)
        )
        loader._MODEL_CACHE.clear()

    # Keep HF progress bars out of the timing output.
    import os

    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")

    from transformers.utils import logging as tf_logging

    tf_logging.set_verbosity_error()

    img = make_deterministic_image()
    png = Path(tempfile.mkdtemp(prefix="satquery_bench_")) / "input.png"
    img.save(png)
    print(f"deterministic image: {png} ({img.size[0]}x{img.size[1]})")

    import torch

    print(
        f"torch {torch.__version__}  cuda={torch.cuda.is_available()}  "
        f"mps={torch.backends.mps.is_available() if torch.backends.mps else False}"
    )

    # ---- 1. Cold model load (both production cache keys) --------------------
    from app.models.vlm_loader import DEFAULT_CAPTION_MODEL

    if not args.skip_load:
        t0 = time.perf_counter()
        load_qwen_model(DEFAULT_VQA_MODEL, ADAPTER)
        print(
            f"cold load VQA (model={DEFAULT_VQA_MODEL}, adapter={'yes' if ADAPTER else 'no'}): "
            f"{time.perf_counter() - t0:.1f}s"
        )
        t0 = time.perf_counter()
        load_qwen_model(DEFAULT_CAPTION_MODEL, None)
        print(
            f"cold load caption (model={DEFAULT_CAPTION_MODEL}, base): "
            f"{time.perf_counter() - t0:.1f}s"
        )

    # ---- 2. Warm inference ------------------------------------------------
    closed_q = "Is there water in this image?"
    structured_q = (
        "Analyze the land cover in this image and describe vegetation health."
    )

    def _token_count(text: str) -> int:
        return len(text.split())

    def _digest(text: str) -> str:
        return hashlib.sha256(text.encode()).hexdigest()[:12]

    vqa_closed, vqa_structured, captions = [], [], []
    closed_tokens, structured_tokens, caption_tokens = [], [], []
    closed_digests, structured_digests, caption_digests = [], [], []
    for _ in range(args.runs):
        t = time.perf_counter()
        ans, _ = run_vqa(img, closed_q, max_new_tokens=64)
        vqa_closed.append(time.perf_counter() - t)
        closed_tokens.append(_token_count(ans))
        closed_digests.append(_digest(ans))
    for _ in range(args.runs):
        t = time.perf_counter()
        ans, _ = run_vqa(img, structured_q, max_new_tokens=256)
        vqa_structured.append(time.perf_counter() - t)
        structured_tokens.append(_token_count(ans))
        structured_digests.append(_digest(ans))
    for _ in range(args.runs):
        t = time.perf_counter()
        cap, _ = run_caption(img, max_new_tokens=512)
        captions.append(time.perf_counter() - t)
        caption_tokens.append(_token_count(cap))
        caption_digests.append(_digest(cap))

    print("\n=== warm inference (total wall time incl. pre/post) ===")
    _report("vqa closed (64 tok)", vqa_closed)
    _report("vqa structured (256 tok)", vqa_structured)
    _report("caption (512 tok)", captions)
    print(f"output words: vqa_closed={closed_tokens} vqa_structured={structured_tokens} "
          f"caption={caption_tokens}")
    print(f"output sha256[:12]: vqa_closed={closed_digests} vqa_structured={structured_digests} "
          f"caption={caption_digests}")
    print(f"repeatability (all runs identical) = "
          f"{len(set(closed_digests)) == 1 and len(set(structured_digests)) == 1 and len(set(caption_digests)) == 1}")

    # ---- 3. Pre / post separated ------------------------------------------
    model, processor = load_qwen_model(DEFAULT_VQA_MODEL, ADAPTER)
    device = next(model.parameters()).device
    messages = [
        {"role": "user", "content": [{"type": "image", "image": img},
                                     {"type": "text", "text": closed_q}]}
    ]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    image_inputs, video_inputs = _import_vision_utils()(messages)

    pre_times = []
    with torch.no_grad():
        for _ in range(2):
            t = time.perf_counter()
            inputs = processor(
                text=[text], images=image_inputs, videos=video_inputs,
                padding=True, return_tensors="pt",
            ).to(device)
            pre_times.append(time.perf_counter() - t)

    _report("preprocess (template+processor+to device)", pre_times)

    dec_times = []
    ids = torch.tensor([[1, 2, 3, 4, 5]])
    for _ in range(2):
        t = time.perf_counter()
        processor.batch_decode(ids, skip_special_tokens=True)
        dec_times.append(time.perf_counter() - t)
    _report("postprocess (batch_decode)", dec_times)

    print("\nnote: device used by loader =", device)
    if args.device == "auto":
        print("  (auto = cuda -> mps -> cpu; MPS fp16 gives byte-identical greedy "
              "output vs CPU float32 on this stack - see scripts/ab_validate_mps.py)")


if __name__ == "__main__":
    main()