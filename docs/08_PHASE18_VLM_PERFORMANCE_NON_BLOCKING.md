# Phase 18 — VLM Performance + Inference Non-Blocking (ML Service)

Status: **DONE** — all suites green.
ML `pytest`: **569 passed** (559 before + 10 new). Backend `npm test`: **35 suites / 476 passed** (unchanged).

---

## 1. Objective

The VLM (Qwen2-VL-2B + LoRA adapter) path ran **synchronously on the FastAPI
event loop** and had real concurrency hazards:

1. **Event-loop blocking** — a single VQA request held the whole app for ~7-27s.
2. **Racy model load** — `_MODEL_CACHE` checkout-then-load had a TOCTOU window:
   concurrent first requests (or warmup racing a request) each build a duplicate
   4GB model copy.
3. **Unserialized shared-model inference** — HF `model.generate` /
   tokenizer / processor on one shared instance are not documented thread-safe.
4. **Under-used hardware** — the loader ran everything on CPU `float32`; the
   Apple M2's MPS backend was never selected.
5. **Incomplete warmup** — `/vlm/warmup` loaded only the VQA+adapter key and ran
   the load on the event loop; the caption base model stayed cold.

Phase 18 makes the VLM path **non-blocking**, thread-safe, and faster, with
**byte-identical output** to the previous path — measured, not assumed.

## 2. Scope and boundaries (explicit)

- **ML service only. No frontend changes.**
- **No async job queue.** Off-loop execution uses `asyncio.to_thread` (the
  standard library worker pool), not a task broker.
- **No quantization forced.** INT8/4-bit was audited and found *infeasible* in
  this environment; evidence below. No new heavyweight deps installed.
- **No output-quality reduction for speed.** Greedy decoding, prompts, max-new
  token budgets (VQA 256 / Caption 512), AOI window-only behavior, the honest
  offline fallback, and the explicit "not determinable" rules are untouched.
- **No workstream reopenings** (AOI/ROI, LLM, prompt/token, science honesty,
  georeference, trend, STAC, SAR).

## 3. What existed before

```
POST /vqa  (async def)
  └ read_upload_file (async, fine)
  └ compute_vqa (SYNC)                      <- THE PROBLEM
       └ aoi_scope  -> raster crop (sync)
       └ load_image_as_pil (sync, rasterio)
       └ run_vqa -> load_qwen_model (lazy, cached, RACY)
                   └ model.generate (sync, several seconds)
```

Both `/vqa` and `/caption` are `async def` but called the whole synchronous
chain directly in the loop. With structured VQA at ~26s on CPU float32, every
other endpoint (health, LLM, SAR, STAC…) hung for the duration of one VLM
request. Load happened lazily on the first request (also in-loop) and could
happen N times under concurrency.

### Audit summary (Phase 1, no code changes; verified before editing)
- Both endpoints block the loop (`grep` for `to_thread`/executor across `app/`:
  none).
- `_MODEL_CACHE` unchecked read-then-write → duplicate-load risk.
- `_device()` = cuda else cpu; `_dtype_for` = bf16-on-cuda else float32.
- No separated warmup of the caption base key; warmup calls were in-loop.
- Environment: Python 3.14.7, PyTorch 2.14.0 (MPS available, no CUDA),
  transformers 5.16.1, peft 0.20.0, **bitsandbytes not installed**, 16GB RAM,
  Apple M2 8-core.

## 4. Changes

| File | Change |
|---|---|
| `ml-service/app/models/vlm_loader.py` | Added `_MODEL_LOAD_LOCK` (single-flight around cache check + build) and `_INFERENCE_LOCK` (serializes template→processor→generate→decode). Extracted the heavy load into `_build_qwen_model`; `load_qwen_model` is now a single-flight cache wrapper. Switched `torch.no_grad()` → `torch.inference_mode()`. `_device()` now: CUDA → MPS → CPU; `_dtype_for`: bf16 (CUDA) / fp16 (MPS) / fp32 (CPU); MPS models also `.to(device)`. |
| `ml-service/app/api/vqa.py` | `compute_vqa(...)` wrapped in `await asyncio.to_thread(functools.partial(...))`; `/vlm/warmup` warms VQA+adapter **and** caption base, runs loads via `to_thread`, surfaces generic errors. |
| `ml-service/app/api/caption.py` | `compute_caption(...)` wrapped in `await asyncio.to_thread(...)`. |
| `ml-service/scripts/benchmark_vlm.py` | Reproducible benchmark; `--device auto/cpu/mps`, per-run output SHA-256 digests + repeatability flag. (Created in Phase 4; *before* edits captured baseline numbers.) |
| `ml-service/scripts/probe_mps.py` (new) | 8-token MPS viability probe. |
| `ml-service/scripts/ab_validate_mps.py` (new) | Full production-path A/B: MPS(fp16) vs CPU(fp32), byte-comparison of all three modalities. Exit 0 iff identical. |
| `ml-service/tests/test_vlm_nonblocking.py` (new) | 10 regression tests, all offline (no model weights needed). |

### Event-loop strategy
Validation, upload read, and response construction stay on the loop. Only the
blocking compute (AOI crop + raster decode + model inference) is moved to a
worker thread via `asyncio.to_thread` + `functools.partial` (kwargs are bound
inside the thread call). Exceptions raised on the worker thread propagate
through `await` unchanged, so the existing `RoiCropError` / `RasterError` /
`VLMUnavailableError` / `VQAError` / generic handlers fire as before.

### Thread-safety strategy
- **Single-flight load:** `_MODEL_LOAD_LOCK` around the `get → build → set`
  sequence. N concurrent loaders for the same key build exactly one instance.
  Verified by test (8 threads → 1 build, same object returned).
- **Inference serialization:** `_INFERENCE_LOCK` (global) wraps
  `apply_chat_template` → `process_vision_info` → `processor(...)` →
  `model.generate(...)` → `batch_decode(...)` — everything that touches the
  shared tokenizer/processor/model. Greedy (`do_sample=False`) output is
  deterministic, so serialization changes nothing numerically (proven below).
  Model *load* is deliberately **outside** the inference lock.

## 5. Device / dtype / quantization decision

| Option | Evidence | Decision |
|---|---|---|
| CUDA + bf16 | Not available (no CUDA here) | kept in code path (unchanged) |
| **MPS + fp16 (new default on Apple Silicon)** | 8-token probe: 2.84s→0.58s (4.9×); full production path (adapter + realistic 256×256 + all three modalities) **byte-identical** to CPU float32 (`scripts/ab_validate_mps.py`); run-to-run repeatable; lower RAM (4.4GB vs 8.8GB resident) | **Adopted**, selected only when `torch.backends.mps.is_available()`; CPU fallback unchanged elsewhere |
| CPU float32 (previous default) | baseline preserved exactly | fallback for non-MPS machines |
| INT8 / 4-bit (bitsandbytes) | bitsandbytes **not installed**; Py3.14.7 + macOS arm64 unsupported; would add a fragile dep for a machine that already has MPS | **Rejected** — not feasible here; re-audit if a CUDA/Linux runtime appears |
| `torch.inference_mode()` vs `no_grad()` | SHA-256 digests of outputs identical | adopted (marginally cheaper); see parity chain below |

### Output parity chain (the honest numbers)
Same synthetic 256×256 image, same prompts, real model+adapter, SHA-256[:12] of
each answer — matched EXACTLY across three independent runs:

| Run | code | device | vqa_closed | vqa_structured | caption |
|---|---|---|---|---|---|
| pre-edit (git HEAD loader, `no_grad`) | CPU f32 | `4d9beb6a778f` | `c08a2277c6be` | `50a50f4c9761` |
| post-edit | CPU f32 | `4d9beb6a778f` | `c08a2277c6be` | `50a50f4c9761` |
| post-edit | MPS f16 | `4d9beb6a778f` | `c08a2277c6be` | `50a50f4c9761` |

All three modalities, all three configurations: identical output. The
non-blocking + locking + MPS changes are **numerically transparent**.

## 6. Benchmark (real model, Apple M2, before → after)

`scripts/benchmark_vlm.py --runs 2` (warm wall-time, incl. pre/post processing):

| Modality (budget) | Before CPU f32 | After CPU f32 | **After MPS f16** |
|---|---|---|---|
| VQA closed (64 tok, ~25 words) | mean 6.964s | 7.077s | **4.462s** (1.6×) |
| VQA structured (256 tok, ~143 words) | mean 25.834s | 25.231s | **10.265s** (2.5×) |
| Caption (512 tok, ~55 words) | mean 11.524s | 11.768s | **5.475s** (2.1×) |
| Cold load VQA+adapter | 19.4s | — | **14.1s** |
| Cold load caption base | 27.6s | — | **20.0s** |

CPU times are stable before/after the code edits (within noise), confirming the
locks/additions add ~zero overhead single-threaded. Preprocess (~0.02s) and
decode (~0.001–0.007s) are negligible; generation dominates and scales with
tokens actually emitted, not the budget ceiling.

Live endpoint timings (real model through FastAPI, MPS): warmup ok `load_seconds`
16.8s; `/vqa` closed ≈ 6.9s (first call, cache-hit only); `/caption` ≈ 6.0s.

## 7. Warmup behavior change (Phase 7)
- Runs in `asyncio.to_thread` (no event-loop stall during load).
- Now warms **both** cache keys: `qwen:<model>:<adapter>` and `qwen:<model>:base`
  (caption no longer pays the first-call cold load — previously a real 22s
  in-line stall).
- Response adds `caption_model` + `caption_load_seconds`; previous fields
  (`status/model/adapter_path/adapter_active/load_seconds`) unchanged.
- Generic exceptions now surface as `status: "unavailable"` instead of crashing.

## 8. Tests

`tests/test_vlm_nonblocking.py` (10 tests, offline, no weights):
- compute runs on a worker thread ≠ event-loop thread (both /vqa and /caption)
- `/health` responds in <1s while a /vqa compute is deliberately blocked
- worker-thread `VQAError`/`RuntimeError` → clean `failed` responses
- single-flight load: 8 concurrent loaders → 1 build, shared instance
- inference serialization: 6 concurrent `run_vqa` / `run_caption` → max active
  `generate` == 1
- warmup schema (`ok`/`adapter_active`/`caption_model`) and `unavailable` path

Existing suites unchanged and green: `test_vqa_api.py`, `test_caption_api.py`,
`test_vlm_prompts.py` (offline-honesty + prompt semantics preserved).

## 9. Verification (real model + full suites)

- ML `pytest`: **569 passed** (559 prior + 10 new) — `19.68s`.
- Backend `npm test`: **35 suites / 476 passed** — unchanged.
- Real-model e2e through FastAPI: warmup (adapter_active=true), `/vqa`
  (answer "no", confidence 0.8, `adapter_used` true, mock absent), `/caption`
  (real caption text).
- Parity chain & MPS identity gates: `scripts/ab_validate_mps.py` exit 0;
  benchmark repeatability flag `True` on MPS.

## 10. Remaining bottlenecks / next steps
- Generation is inherently sequential (~0.07 s/token MPS); a concurrent-request
  queue would recover throughput but is explicitly out of scope (no async job
  queue). With the global `_INFERENCE_LOCK`, concurrent VLM requests serialize —
  that is a deliberate correctness-first choice for a 16GB single-worker box.
- MPS adoption is Apple-Silicon-specific and guarded by `is_available()`; any
  CUDA/Linux deploy keeps the bf16 path. If a CUDA runtime appears, re-audit
  bitsandbytes INT8 for memory-constrained hosts.
- Vision-token preprocessing cost scales with input resolution; a resolution
  cap could be revisited only with explicit output-quality validation.