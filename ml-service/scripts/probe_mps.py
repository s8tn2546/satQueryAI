"""Probe whether MPS acceleration is viable for this VLM on this machine.

Loads the base Qwen2-VL model once (bf16 to bound RAM), runs a tiny
deterministic generation on CPU vs MPS, compares wall time and whether the
decoded output is identical (greedy). 8 tokens only, to keep the probe bounded.

This is a measurement probe for the Phase 18 report; it does not change any
production code path.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")

from dotenv import load_dotenv

env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

from transformers.utils import logging as tf_logging

tf_logging.set_verbosity_error()

import torch
from PIL import Image


def _image():
    import numpy as np

    arr = np.zeros((8, 8, 3), dtype=np.uint8)
    arr[:, :4] = (60, 140, 50)
    arr[:, 4:] = (40, 90, 160)
    return Image.fromarray(arr, mode="RGB")


def main() -> None:
    from transformers import AutoProcessor, Qwen2VLForConditionalGeneration

    print(f"torch {torch.__version__} mps={torch.backends.mps.is_available()}")
    if not torch.backends.mps.is_available():
        print("MPS_not_available")
        return

    model_id = os.environ.get("VLM_MODEL", "Qwen/Qwen2-VL-2B-Instruct")
    proc = AutoProcessor.from_pretrained(model_id)

    def _run(device, dtype):
        model = Qwen2VLForConditionalGeneration.from_pretrained(
            model_id, torch_dtype=dtype
        ).to(device)
        model.eval()
        img = _image()
        messages = [
            {"role": "user", "content": [{"type": "image", "image": img},
                                         {"type": "text", "text": "Describe briefly."}]}
        ]
        text = proc.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        from qwen_vl_utils import process_vision_info

        imgs, vids = process_vision_info(messages)
        inputs = proc(text=[text], images=imgs, videos=vids, padding=True,
                      return_tensors="pt").to(device)
        # Warmup pass on the device.
        with torch.inference_mode():
            model.generate(**inputs, max_new_tokens=4, do_sample=False)
        t0 = time.perf_counter()
        with torch.inference_mode():
            out = model.generate(**inputs, max_new_tokens=8, do_sample=False)
        dt = time.perf_counter() - t0
        answer = proc.batch_decode(out[:, inputs.input_ids.shape[1]:],
                                   skip_special_tokens=True)[0].strip()
        del model
        torch.mps.empty_cache() if hasattr(torch, "mps") else None
        return dt, answer

    try:
        cpu_s, ans_cpu = _run("cpu", torch.float32)
        print(f"cpu  (f32) 8 tok: {cpu_s:.2f}s  -> {ans_cpu!r}")
    except Exception as exc:  # noqa: BLE001
        print(f"cpu (f32) FAILED: {exc}")

    try:
        mps_s, ans_mps = _run("mps", torch.float16)
        print(f"mps  (f16) 8 tok: {mps_s:.2f}s  -> {ans_mps!r}")
        print(f"identical_output = {ans_cpu == ans_mps}")
    except Exception as exc:  # noqa: BLE001
        print(f"mps (f16) FAILED: {exc}")

    try:
        mps_s, ans_mps = _run("mps", torch.float32)
        print(f"mps  (f32) 8 tok: {mps_s:.2f}s  -> {ans_mps!r}")
        print(f"identical_output_f32 = {ans_cpu == ans_mps}")
    except Exception as exc:  # noqa: BLE001
        print(f"mps (f32) FAILED: {exc}")


if __name__ == "__main__":
    main()