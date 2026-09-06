# LoRA Fine-Tuning for Remote Sensing VQA

This directory contains the infrastructure for adapting the base VLM
(Qwen2-VL-2B-Instruct) to remote sensing imagery via LoRA fine-tuning on the
RSVQA-HR dataset. **No training has been completed yet** — this is a hardened,
ready-to-run pipeline. Checkpoints and evaluation results are produced only
when a real run is executed.

## Status

- ✅ Training pipeline implemented and repaired (dependency handling, label
  construction, precision, reproducibility, checkpoints, eval)
- ✅ Requirements file (`requirements-training.txt`) defined
- 🟡 Real training **not yet executed** (requires heavy dependencies + GPU)
- ⚠️ Smoke test **blocked by environment** in the current local setup (heavy
  stack not installed) — see [Smoke Test](#smoke-test)

## Overview

**Base Model**: `Qwen/Qwen2-VL-2B-Instruct` (2.2B parameters)

**Dataset**: `cpratikaki/RSVQA-HR_qwen_finetuning` (train split, streamed)
- Remote sensing visual question answering (RSVQA-HR)
- Question types: yes/no, counting, area estimation, object presence
- Answers are short lowercase strings (e.g. `yes`, `no`, `3`, `farmland`)

**LoRA Configuration** (defaults):
- Rank: 16, Alpha: 32, Dropout: 0.05
- Target modules: `q_proj`, `v_proj` (self-attention in the LLM decoder)
- Trainable parameters: ~8.4M (~0.4% of base)

**Training Parameters** (defaults):
- Learning rate: 3e-4 with 50-step warmup
- Batch size: 4
- Training steps: 500
- Subset: 2000 samples (holdout 200 for eval)
- Max sequence length: 1024 (image tokens + text)

## Training Dependencies

The training pipeline depends on the heavy deep-learning stack. These are
**separate from the runtime service** (`requirements.txt`) so the serving image
stays lean.

```bash
cd ml-service
pip install -r requirements-training.txt
```

contents: `torch`, `torchvision`, `transformers`, `peft`, `accelerate`,
`qwen-vl-utils`, `datasets`, `Pillow`.

**Note:** `torch` must be a build matching your compute (e.g. the CUDA wheel on
Linux with an NVIDIA GPU). The current local environment (Python 3.14) does not
have these installed.

## Smoke Test

A tiny smoke run exercises the REAL pipeline (dataset loading, image
preprocessing, model loading, LoRA attachment, forward/backward, optimizer
step) to catch label-shape, processor, image-tensor, LoRA, dtype, and dataset
errors — without launching a 500-step run.

```bash
cd ml-service
python3 adaptation/train_lora_rsvqa.py --steps 2 --subset 8 --batch-size 1
```

**Environment status:** this currently fails before model load because the
heavy training stack is not installed (`torch`/`transformers`/`peft`/
`datasets`/`qwen-vl-utils`). The script exits with a clear message. Install
`requirements-training.txt` and retry to get a genuine PASS.

## Real Training

```bash
cd ml-service
python3 adaptation/train_lora_rsvqa.py
```

Runs the default configuration (500 steps, 2000 samples, batch 4). **Do not run
this unsupervised** — it requires several GB of VRAM/disk and takes
significant time on CPU. It should be a separately authorized operation.

Common options (all configurable via CLI):

| Flag | Default | Purpose |
|------|---------|---------|
| `--model` | `Qwen/Qwen2-VL-2B-Instruct` | Base model id |
| `--dataset` | `cpratikaki/RSVQA-HR_qwen_finetuning` | Dataset id |
| `--subset` | 2000 | Total samples (train + eval) |
| `--holdout` | 200 | Samples held out for eval |
| `--batch-size` | 4 | Training batch size |
| `--steps` | 500 | Training steps |
| `--learning-rate` | 3e-4 | AdamW LR |
| `--warmup-steps` | 50 | Linear warmup steps |
| `--max-length` | 1024 | Max sequence tokens (image + text) |
| `--output-dir` | `adaptation/checkpoint` | Adapter output dir |
| `--seed` | 42 | Random seed |
| `--eval-samples` | 20 | Eval sample count (exact match) |
| `--save-every` | 100 | Save an adapter every N steps (0 = off) |
| `--resume-from-checkpoint` | — | Resume adapter weights from a saved dir |
| `--device` | auto | `cuda` / `cpu` / `mps` override |
| `--lora-rank/alpha/dropout` | 16/32/0.05 | LoRA hyperparameters |
| `--target-modules` | `q_proj,v_proj` | LoRA target modules |

## Output Checkpoints

PEFT-compatible LoRA adapters (loadable via `PeftModel.from_pretrained`):

- `adaptation/checkpoint/` — final adapter
- `adaptation/checkpoint/step-<N>/` — periodic adapters (every `--save-every` steps)

Each adapter dir contains `adapter_config.json` + `adapter_model.safetensors`
(or `.bin`), plus a small `TRAINING_NOTE.json`.

The script runs a structural validation after saving to confirm the directory
contains what inference expects.

## Evaluation Output

`adaptation/eval_results.json` records (when a run completes):
- Base vs adapted accuracy, and delta (repo's **lightweight exact-match,
  lowercased** metric — not benchmark-grade)
- Sample count, model name, adapter path, LR, batch, max length, seed, dtype,
  device, timestamp, checkpoints saved, and adapter validation info

No evaluation numbers are fabricated: they appear only after a real run.

## GPU / Precision Expectations

The script selects precision automatically (safe, no mixed-precision magic):

- **CUDA + bf16** if the GPU supports it, else **CUDA + fp16**
- **MPS** (Apple Silicon) detected explicitly, runs in float32
- **CPU** runs in float32

Startup logs print the device, dtype, GPU name and available VRAM (when CUDA).

**Memory:** FP32 was too heavy for many GPUs, hence bf16/fp16 on CUDA. No exact
VRAM requirement is claimed without measurement — reduce `--batch-size` /
`--max-length` if you hit OOM.

## Reproducibility

`--seed` (default 42) seeds Python `random`, NumPy, torch, CUDA, and cuDNN
deterministic modes. The eval sample selection is seeded and deterministic per
seed. Note that full bit-for-bit reproducibility can still vary across
hardware/CPU/CUDA kernels (this is documented, not guaranteed).

## Resume Behavior

- `--resume-from-checkpoint <dir>` loads the LoRA adapter weights from a saved
  directory and continues training.
- **Optimizer / scheduler state is NOT preserved** — warmup restarts. This is
  documented and by design (adapter-only resume).
- Intermediate checkpoints use separate `step-<N>` directories so a prior
  checkpoint is not corrupted.

## Current Limitations

- No training has been run yet; no checkpoint or eval results exist yet.
- Label construction aligns to the full sequence and masks prompt/padding with
  `-100`; if a full sequence exceeds `--max-length`, the answer tail may be
  truncated (raise `--max-length` to avoid).
- Evaluation is lightweight exact-match, not a benchmark.
- No gradient accumulation / distributed training (single-device only).

## Configuring the Adapted Adapter for VQA

After a successful training run, point the VQA loader at the final adapter:

1. Set `.env` (or environment):
   ```bash
   VQA_ADAPTER_PATH=./adaptation/checkpoint
   ```
2. Restart the ML service. The `/vqa` endpoint (`app/models/vlm_loader.py`)
   loads the adapter via `PeftModel.from_pretrained(base_model, adapter_path)`.

**Compatibility requirements verified by the pipeline:**
- The trained base model must be the SAME as the inference base model
  (`Qwen/Qwen2-VL-2B-Instruct` by default).
- The adapter is saved in PEFT format (`adapter_config.json` +
  `adapter_model.safetensors`), which is what the loader expects.
- Dtype differences are handled by loading the base model in bf16 on CUDA /
  fp32 on CPU, matching the training precision on each device.

If the adapter path does not exist, the endpoint keeps the existing offline
VQA fallback (no behavior change).

## References

- Qwen2-VL: https://arxiv.org/abs/2409.12191
- RSVQA: https://rsvqa.sylvainlobry.com/
- LoRA: https://arxiv.org/abs/2106.09685
- PEFT: https://github.com/huggingface/peft
