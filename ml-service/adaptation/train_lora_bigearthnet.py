#!/usr/bin/env python3
"""LoRA fine-tuning of Qwen2-VL-2B-Instruct on BigEarthNet.txt (remote sensing).

This script is the Kaggle-side training entrypoint for the BigEarthNet.txt
adaptation pipeline.  It mirrors the proven RSVQA training script
(``train_lora_rsvqa.py``) but trains on the official BigEarthNet.txt parquet +
Encoded-BigEarthNet LMDB imagery, with TWO RGB image composites per sample
(a Sentinel-2 false-color composite and a Sentinel-1 composite).

Pipeline stages:
  1. Read BigEarthNet.txt annotations (binary / mcq) for a deterministic
     ``--subset`` of unique image pairs (patches), with a no-leakage
     train/eval split at the *patch* level (``split_patches_no_leakage``).
  2. Load the official Encoded-BigEarthNet LMDB through ``BENImageReader`` and
     build the two composites per patch (days are cached per patch, so a
     patch's multiple annotations share a single LMDB read).
  3. Evaluate the BASE model on the held-out patches (lightweight exact match).
  4. Apply LoRA via peft (q_proj / v_proj, rank 16) and train.
  5. Evaluate the ADAPTED model on the same held-out patches.
  6. Save the PEFT adapter to ``bigearthnet_adapter/`` and write
     ``bigearthnet_eval.json``.

This script NEVER falls back to metadata-only or synthetic imagery: launching
it without the official LMDB fails loudly via ``run_preflight`` / the reader's
``ImageryNotAvailableError``.

Usage:
  # Preflight (fast, no heavy model load; refuses to run without imagery):
  python3 adaptation/train_lora_bigearthnet.py --preflight \
      --parquet /kaggle/working/BigEarthNet.txt/BigEarthNet.txt.parquet \
      --lmdb    /kaggle/working/BigEarthNet.txt/Encoded-BigEarthNet/

  # Real training (validated config — do not run without explicit approval):
  python3 adaptation/train_lora_bigearthnet.py \
      --parquet /kaggle/working/BigEarthNet.txt/BigEarthNet.txt.parquet \
      --lmdb    /kaggle/working/BigEarthNet.txt/Encoded-BigEarthNet/

  # Tiny smoke test (2 optimizer steps on 8 patches, 1 micro-batch each):
  python3 adaptation/train_lora_bigearthnet.py \
      --parquet /kaggle/working/BigEarthNet.txt/BigEarthNet.txt.parquet \
      --lmdb    /kaggle/working/BigEarthNet.txt/Encoded-BigEarthNet/ \
      --steps 2 --subset 8 --eval-samples 4 --batch-size 1

  # Evaluate against the official 1082-patch bench split instead of holdout:
  ... --eval-bench --eval-samples 1082

Output:
  adaptation/bigearthnet_adapter/    — final LoRA adapter (PeftModel-loadable)
  adaptation/bigearthnet_adapter/step-<n>/ — periodic intermediate adapters
  adaptation/bigearthnet_eval.json   — before/after numbers + config metadata
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger("train_lora_bigearthnet")


def _check_required_deps() -> None:
    """Fail fast with a clear message if the heavy training stack is missing."""
    missing = []
    for mod in (
        "torch", "PIL", "pandas", "lmdb", "safetensors",
        "qwen_vl_utils", "peft", "transformers",
    ):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        logger.error(
            "Training dependencies are not installed: %s. "
            "Install them with: pip install -r requirements-training.txt",
            ", ".join(missing),
        )
        sys.exit(2)


_check_required_deps()

import torch  # noqa: E402
from PIL import Image  # noqa: E402
from qwen_vl_utils import process_vision_info  # noqa: E402

# Ensure ``ml-service`` is on sys.path so this script runs from any CWD.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from adaptation._train_helpers import effective_batch_size  # noqa: E402
from adaptation.bigearthnet_dataset import (  # noqa: E402
    BigEarthNetDataset,
    BigEarthNetQwenDataset,
    ImageryNotAvailableError,
    PreflightError,
    build_qwen_conversation,
    collate_bigearthnet_batch,
    run_preflight,
    select_eval_samples,
    split_patches_no_leakage,
    validate_samples,
)


BASE_MODEL  = "Qwen/Qwen2-VL-2B-Instruct"
BASE_DIR    = Path(__file__).parent.resolve()
DEFAULT_OUT = BASE_DIR / "bigearthnet_adapter"
EVAL_FILE   = BASE_DIR / "bigearthnet_eval.json"

# Kept identical to the validated RSVQA configuration.
LORA_RANK    = 16
LORA_ALPHA   = 32
LORA_DROPOUT = 0.05
TARGET_MODULES = ["q_proj", "v_proj"]

LR     = 3e-4
WARMUP = 50


def seed_everything(seed: int) -> None:
    """Seed all relevant random generators for reproducibility."""
    random.seed(seed)
    try:
        import numpy as np
        np.random.seed(seed)
    except ImportError:
        pass
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False


def resolve_device(override: str | None) -> torch.device:
    """Pick the best available device, with explicit MPS detection."""
    if override:
        return torch.device(override)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def resolve_dtype(device: torch.device) -> torch.dtype:
    if device.type == "cuda":
        if torch.cuda.is_bf16_supported():
            return torch.bfloat16
        return torch.float16
    return torch.float32


def log_hardware(device: torch.device, dtype: torch.dtype) -> None:
    logger.info("Device: %s", device)
    logger.info("Dtype : %s", dtype)
    if device.type == "cuda":
        name = torch.cuda.get_device_name(device)
        vram = torch.cuda.get_device_properties(device).total_memory / (1024 ** 3)
        logger.info("GPU   : %s (%.1f GB VRAM)", name, vram)
    elif device.type == "mps":
        logger.info("GPU   : Apple Silicon (MPS)")


def validate_first_sample(ds: BigEarthNetQwenDataset, device: torch.device, dtype: torch.dtype) -> None:
    """Log enough about the first training example to sanity-check preprocessing."""
    if len(ds) == 0:
        raise ValueError("Cannot validate: the training dataset is empty.")
    s = ds.samples[0]
    logger.info("=== Validating first training example ===")
    logger.info("  s2 image %sx%s mode=%s", *s["s2_rgb"].size, s["s2_rgb"].mode)
    logger.info("  s1 image %sx%s mode=%s", *s["s1_rgb"].size, s["s1_rgb"].mode)
    logger.info("  question     : %r", str(s["question"])[:120])
    logger.info("  answer       : %r", str(s["answer"])[:120])
    item = ds[0]
    non_masked = int((item["labels"] != -100).sum())
    logger.info("  input_ids    : shape=%s dtype=%s", tuple(item["input_ids"].shape), item["input_ids"].dtype)
    logger.info("  labels       : shape=%s dtype=%s", tuple(item["labels"].shape), item["labels"].dtype)
    logger.info("  non-masked label tokens: %d", non_masked)
    logger.info("  pixel_values : shape=%s", tuple(item["pixel_values"].shape))
    logger.info("  image_grid_thw: shape=%s", tuple(item["image_grid_thw"].shape))
    if "mm_token_type_ids" in item and item["mm_token_type_ids"] is not None:
        logger.info("  mm_token_type_ids: shape=%s", tuple(item["mm_token_type_ids"].shape))
    else:
        logger.info("  mm_token_type_ids: absent (model will infer modality from input_ids)")
    logger.info("  device       : %s  dtype=%s", device, dtype)
    if non_masked == 0:
        raise RuntimeError(
            "Validation failed: zero non-masked label tokens for the first sample. "
            "Increase --max-length."
        )


def _infer_two_image(
    model,
    processor,
    s2_rgb: Image.Image,
    s1_rgb: Image.Image,
    question: str,
    device: torch.device,
) -> str:
    """Run a single two-image VQA inference and return the decoded answer (lowercased)."""
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": s2_rgb},
                {"type": "image", "image": s1_rgb},
                {"type": "text", "text": question},
            ],
        }
    ]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    image_inputs, video_inputs = process_vision_info(messages)
    inputs = processor(
        text=[text],
        images=image_inputs,
        videos=video_inputs,
        padding=True,
        return_tensors="pt",
    ).to(device)

    with torch.no_grad():
        output_ids = model.generate(**inputs, max_new_tokens=20, do_sample=False)

    output_ids = output_ids[:, inputs.input_ids.shape[1]:]
    return processor.batch_decode(output_ids, skip_special_tokens=True)[0].strip().lower()


def exact_match_accuracy(
    model,
    processor,
    samples: list[dict],
    device: torch.device,
) -> tuple[float, int, int]:
    """Lightweight exact-match (lowercased) accuracy over a sample list."""
    model.eval()
    correct = total = 0
    for s in samples:
        ref = str(s["answer"]).strip().lower()
        pred = _infer_two_image(
            model, processor, s["s2_rgb"], s["s1_rgb"], str(s["question"]), device
        )
        if pred == ref:
            correct += 1
        total += 1
    return (correct / total if total else 0.0), total, correct


def validate_adapter_dir(adapter_dir: Path, model_name: str) -> dict:
    """Structurally verify a saved PEFT LoRA adapter without inference."""
    cfg_path = adapter_dir / "adapter_config.json"
    if not cfg_path.exists():
        raise ValueError(f"Adapter dir {adapter_dir} is missing adapter_config.json")
    cfg = json.loads(cfg_path.read_text())

    weights = [
        p for p in (
            adapter_dir / "adapter_model.safetensors",
            adapter_dir / "adapter_model.bin",
        ) if p.exists()
    ]
    if not weights:
        raise ValueError(
            f"Adapter dir {adapter_dir} is missing adapter weights "
            f"(adapter_model.safetensors or adapter_model.bin)"
        )

    cfg_model = cfg.get("base_model_name_or_path")
    if cfg_model and cfg_model not in model_name:
        logger.warning(
            "Adapter base model (%s) does not match training base model (%s).",
            cfg_model, model_name,
        )

    logger.info("Adapter OK: %s (%s)", weights[0].name, cfg.get("peft_type", "?"))
    return {
        "adapter_path": str(adapter_dir),
        "adapter_model": weights[0].name,
        "peft_type": cfg.get("peft_type"),
        "base_model_name_or_path": cfg_model,
        "target_modules": cfg.get("target_modules"),
        "rank": cfg.get("r"),
        "lora_alpha": cfg.get("lora_alpha"),
        "lora_dropout": cfg.get("lora_dropout"),
    }


def save_adapter(model, out_dir: Path) -> None:
    """Persist a PEFT LoRA adapter atomically (best-effort metadata note)."""
    import shutil

    out_dir = Path(out_dir)
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    tmp_dir = out_dir.parent / (out_dir.name + ".tmp")
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    model.save_pretrained(str(tmp_dir))
    if out_dir.exists():
        shutil.rmtree(out_dir)
    tmp_dir.rename(out_dir)

    try:
        note = {
            "note": (
                "PEFT LoRA adapter. Load with "
                "PeftModel.from_pretrained(base_model, <this dir>). "
                "Optimizer/scheduler state is not preserved."
            )
        }
        (out_dir / "TRAINING_NOTE.json").write_text(json.dumps(note, indent=2))
    except OSError:
        pass


def run_preflight_mode(args: argparse.Namespace) -> dict:
    """Full preflight: dataset/LMDB checks + processor round-trip check.

    Runs ``run_preflight`` from the dataset module (parquet + LMDB + composite
    checks) and, when that passes, validates that AutoProcessor can tokenize a
    real two-image conversation within ``--max-length``.  Never loads the model.
    """
    logger.info("=== BigEarthNet.txt preflight ===")
    report = run_preflight(
        args.parquet,
        args.lmdb,
        types=[t.strip() for t in args.types.split(",") if t.strip()],
        max_patches=1,
    )
    for c in report["checks"]:
        logger.info("  [%s] %s: %s", "OK" if c["ok"] else "FAIL", c["name"], c["detail"])

    logger.info("Processor round-trip check (no model load)...")
    from transformers import AutoProcessor

    processor = AutoProcessor.from_pretrained(args.model)
    ds = BigEarthNetDataset(
        args.parquet,
        args.lmdb,
        types=[t.strip() for t in args.types.split(",") if t.strip()],
        splits=("train",),
        subset=1,
        seed=args.seed,
    )
    sample = ds.materialize(ds.patches[:1])[0]
    user_msg, assistant_msg = build_qwen_conversation(
        sample["s2_rgb"], sample["s1_rgb"], sample["question"], sample["answer"]
    )
    full_text = processor.apply_chat_template(
        [user_msg, assistant_msg], tokenize=False, add_generation_prompt=False
    )
    image_inputs, video_inputs = process_vision_info([user_msg])
    encoded = processor(
        text=[full_text], images=image_inputs, videos=video_inputs,
        return_tensors="pt", return_mm_token_type_ids=True,
    )
    seq = encoded["input_ids"].shape[-1]
    n_images = encoded["image_grid_thw"].shape[0]
    report["processor_check"] = {
        "chat_template": "ok",
        "sequence_length": int(seq),
        "max_length": args.max_length,
        "n_images": int(n_images),
        "fits_max_length": int(seq) <= args.max_length,
    }
    ok = int(seq) <= args.max_length and n_images == 2
    report["ok"] = bool(ok)
    logger.info(
        "  two-image conversation: %d images, %d tokens (max_length=%d) -> %s",
        n_images, seq, args.max_length, "OK" if ok else "OVER limit",
    )
    if not ok:
        raise PreflightError(
            "Processor round-trip FAILED: two-image conversation lengths are out "
            f"of range (n_images={n_images}, seq={seq}, max_length={args.max_length})."
        )
    logger.info("=== Preflight OK ===")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(
        description="LoRA fine-tune Qwen2-VL on BigEarthNet.txt (two-image composites)"
    )
    parser.add_argument("--model", type=str, default=BASE_MODEL, help="HF base model id")
    parser.add_argument("--parquet", required=True, help="Path to BigEarthNet.txt.parquet")
    parser.add_argument("--lmdb", required=True, help="Path to Encoded-BigEarthNet LMDB dir")
    parser.add_argument("--types", type=str, default="binary,mcq",
                        help="Comma-separated annotation types (default: binary,mcq)")
    parser.add_argument("--categories", type=str, default=None,
                        help="Comma-separated category filter (optional)")
    parser.add_argument("--eval-bench", action="store_true",
                        help="Evaluate against the official 'bench' split instead of a holdout")
    parser.add_argument("--preflight", action="store_true",
                        help="Run preflight checks (dataset + LMDB + processor) and exit")
    parser.add_argument("--subset", type=int, default=2000,
                        help="Unique image pairs (patches) to use for train+eval (default 2000)")
    parser.add_argument("--holdout", type=int, default=200,
                        help="Patches held out for eval (no-leakage patch-level split)")
    parser.add_argument("--batch-size", type=int, default=1,
                        help="Physical micro-batch size per forward/backward pass (default 1)")
    parser.add_argument("--grad-accum", type=int, default=4,
                        help="Gradient accumulation steps: effective batch = "
                             "--batch-size × --grad-accum")
    parser.add_argument("--gradient-checkpointing", dest="gradient_checkpointing",
                        action=argparse.BooleanOptionalAction, default=True,
                        help="Gradient checkpointing (default: enabled)")
    parser.add_argument("--steps", type=int, default=500, help="Number of training steps")
    parser.add_argument("--learning-rate", type=float, default=LR, help="AdamW learning rate")
    parser.add_argument("--warmup-steps", type=int, default=WARMUP, help="Linear warmup steps")
    parser.add_argument("--max-length", type=int, default=1536,
                        help="Max sequence length (2x image tokens + text). Must be large "
                             "enough to keep the answer from being truncated.")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUT, help="Adapter output dir")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for reproducibility")
    parser.add_argument("--eval-samples", type=int, default=20, help="Number of eval samples (exact match)")
    parser.add_argument("--save-every", type=int, default=100, help="Save an adapter every N steps (0 disables)")
    parser.add_argument("--resume-from-checkpoint", type=Path, default=None,
                        help="Path to a saved adapter dir to resume weights from (optimizer/"
                             "scheduler state is NOT preserved)")
    parser.add_argument("--device", type=str, default=None,
                        help="Override device: cuda / cpu / mps (default: auto-detect)")
    parser.add_argument("--lora-rank", type=int, default=LORA_RANK)
    parser.add_argument("--lora-alpha", type=int, default=LORA_ALPHA)
    parser.add_argument("--lora-dropout", type=float, default=LORA_DROPOUT)
    parser.add_argument("--target-modules", type=str,
                        default=",".join(TARGET_MODULES),
                        help="Comma-separated target module names")
    args = parser.parse_args()

    if args.batch_size < 1:
        parser.error("--batch-size must be >= 1")
    if args.grad_accum < 1:
        parser.error("--grad-accum must be >= 1")
    if args.subset < 1:
        parser.error("--subset must be >= 1")

    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")

    types = [t.strip() for t in args.types.split(",") if t.strip()]
    categories = None
    if args.categories:
        categories = [c.strip() for c in args.categories.split(",") if c.strip()]

    if args.preflight:
        try:
            report = run_preflight_mode(args)
        except PreflightError as exc:
            logger.error("Preflight FAILED: %s", exc)
            sys.exit(2)
        except ImageryNotAvailableError as exc:
            logger.error("Preflight FAILED (imagery unavailable): %s", exc)
            sys.exit(2)
        (Path(args.output_dir).parent / "bigearthnet_preflight.json").write_text(
            json.dumps(report, indent=2, default=str)
        )
        return

    from transformers import AutoProcessor, Qwen2VLForConditionalGeneration
    from peft import LoraConfig, PeftModel, get_peft_model

    target_modules = [m.strip() for m in args.target_modules.split(",") if m.strip()]

    seed_everything(args.seed)
    logger.info("Seed: %d", args.seed)

    device = resolve_device(args.device)
    dtype = resolve_dtype(device)
    log_hardware(device, dtype)

    logger.info("Loading base model: %s", args.model)
    processor = AutoProcessor.from_pretrained(args.model)
    model = Qwen2VLForConditionalGeneration.from_pretrained(
        args.model,
        torch_dtype=dtype,
        device_map="auto" if device.type == "cuda" else None,
    )
    if device.type != "cuda":
        model.to(device)

    if args.gradient_checkpointing:
        logger.info("Gradient checkpointing: ON (reduced activation memory)")
        model.enable_input_require_grads()
        model.gradient_checkpointing_enable()
    else:
        logger.info("Gradient checkpointing: OFF")

    # ---- Datasets ----
    # Training pool: deterministic ``--subset`` of unique parts of the train
    # split.  Eval is either a patch-level no-leakage holdout of that pool, or
    # the official bench split (--eval-bench).
    train_ds = BigEarthNetDataset(
        args.parquet, args.lmdb, types=types,
        splits=("train",), categories=categories,
        subset=args.subset, seed=args.seed,
    )
    logger.info(
        "Loaded %d train patches / %d annotations (types=%s)",
        train_ds.num_patches, train_ds.num_annotations, types,
    )

    eval_ds: BigEarthNetDataset | None = None
    src = "holdout"
    if args.eval_bench:
        eval_ds = BigEarthNetDataset(
            args.parquet, args.lmdb, types=types,
            splits=("bench",), categories=categories,
            subset=args.eval_samples, seed=args.seed,
        )
        eval_patches = eval_ds.patches
        src = "bench"
    else:
        train_patches, eval_patches = split_patches_no_leakage(
            train_ds.patches, args.holdout, seed=args.seed
        )
        train_ds.patches = train_patches

    train_samples = train_ds.materialize(train_ds.patches)
    logger.info("Train annotations: %d  Eval patches (%s): %d",
                len(train_samples), src, len(eval_patches))
    validate_samples(train_samples[:50] if len(train_samples) > 50 else train_samples)

    # Eval samples are materialized on the eval dataset lazy image path; when
    # the eval patches come from the same dataset they are already cached.
    eval_dataset = eval_ds if eval_ds is not None else train_ds
    eval_pool = eval_dataset.materialize(eval_patches)
    base_eval = select_eval_samples(eval_pool, args.eval_samples, args.seed)
    logger.info("Eval samples: %d (%s)", len(base_eval), src)
    validate_samples(base_eval or eval_pool[:1])

    # ---- Baseline evaluation (BASE model, before LoRA) ----
    logger.info("=== Evaluating BASE model (%d samples) ===", len(base_eval))
    base_acc, total, correct = exact_match_accuracy(
        model, processor, base_eval, device
    )
    logger.info("Base accuracy: %.4f (%d/%d)", base_acc, correct, total)

    # ---- Apply LoRA (or resume from an existing LoRA adapter) ----
    logger.info(
        "=== Applying LoRA (rank=%d, target=%s) ===", args.lora_rank, target_modules
    )
    if args.resume_from_checkpoint is not None:
        if not Path(args.resume_from_checkpoint).exists():
            raise FileNotFoundError(f"Resume checkpoint not found: {args.resume_from_checkpoint}")
        logger.info("Resuming LoRA weights from: %s", args.resume_from_checkpoint)
        model = PeftModel.from_pretrained(
            model, str(args.resume_from_checkpoint), is_trainable=True
        )
    else:
        lora_cfg = LoraConfig(
            r=args.lora_rank,
            lora_alpha=args.lora_alpha,
            lora_dropout=args.lora_dropout,
            target_modules=target_modules,
            bias="none",
        )
        model = get_peft_model(model, lora_cfg)
    model.print_trainable_parameters()

    train_qwen = BigEarthNetQwenDataset(train_samples, processor, args.max_length)
    validate_first_sample(train_qwen, device, dtype)

    train_loader = torch.utils.data.DataLoader(
        train_qwen, batch_size=args.batch_size, shuffle=True, drop_last=True,
        collate_fn=collate_bigearthnet_batch,
    )

    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad], lr=args.learning_rate
    )
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer, lambda s: min(1.0, s / args.warmup_steps)
    )

    model.train()
    step = 0
    loss_sum = 0.0
    micro_step = 0
    accum_steps = args.grad_accum
    effective_batch = effective_batch_size(args.batch_size, args.grad_accum)
    final_dir = args.output_dir
    checkpoints_saved: list[str] = []

    logger.info(
        "=== Training for %d steps (physical batch=%d grad_accum=%d effective_batch=%d "
        "lr=%.0e max_len=%d) ===",
        args.steps, args.batch_size, accum_steps, effective_batch,
        args.learning_rate, args.max_length,
    )

    while step < args.steps:
        for batch in train_loader:
            if step >= args.steps:
                break

            input_ids = batch["input_ids"].to(device)
            attn_mask = batch["attention_mask"].to(device)
            pixel_vals = batch["pixel_values"].to(device)
            grid_thw = batch["image_grid_thw"].to(device)
            labels = batch["labels"].to(device)
            mm_tids = batch.get("mm_token_type_ids")
            if mm_tids is not None:
                mm_tids = mm_tids.to(device)

            if input_ids.shape[-1] != labels.shape[-1]:
                raise RuntimeError(
                    f"Shape mismatch: input_ids {tuple(input_ids.shape)} vs "
                    f"labels {tuple(labels.shape)}."
                )
            if mm_tids is not None and input_ids.shape[-1] != mm_tids.shape[-1]:
                raise RuntimeError(
                    f"Shape mismatch: input_ids {tuple(input_ids.shape)} vs "
                    f"mm_token_type_ids {tuple(mm_tids.shape)}."
                )

            fwd_kwargs = dict(
                input_ids=input_ids,
                attention_mask=attn_mask,
                pixel_values=pixel_vals,
                image_grid_thw=grid_thw,
                labels=labels,
            )
            if mm_tids is not None:
                fwd_kwargs["mm_token_type_ids"] = mm_tids
            outputs = model(**fwd_kwargs)
            loss = outputs.loss / accum_steps
            loss.backward()
            loss_sum += outputs.loss.item() / accum_steps
            micro_step += 1

            if micro_step == accum_steps:
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad()
                micro_step = 0
                step += 1

                if args.save_every > 0 and step % args.save_every == 0:
                    ckpt = args.output_dir / f"step-{step}"
                    save_adapter(model, ckpt)
                    checkpoints_saved.append(str(ckpt))
                    logger.info("  saved checkpoint -> %s", ckpt)

                if step % 50 == 0:
                    logger.info(
                        "  step %4d/%d  loss=%.4f  lr=%.2e",
                        step, args.steps, loss_sum / 50,
                        optimizer.param_groups[0]["lr"],
                    )
                    loss_sum = 0.0

    logger.info("Training complete (%d steps)", step)
    if step == 0:
        logger.warning("No training steps ran (steps=%d, batch may exceed train size).", args.steps)

    # ---- Adapted evaluation ----
    logger.info("=== Evaluating ADAPTED model (%d samples) ===", len(base_eval))
    adapted_acc, total, correct = exact_match_accuracy(
        model, processor, base_eval, device
    )
    logger.info("Adapted accuracy: %.4f (%d/%d)", adapted_acc, correct, total)

    # ---- Save final adapter ----
    save_adapter(model, final_dir)
    logger.info("LoRA adapter -> %s", final_dir)

    adapter_info = None
    try:
        adapter_info = validate_adapter_dir(final_dir, args.model)
    except Exception as exc:
        logger.error("Adapter structural validation FAILED: %s", exc)
        adapter_info = None

    # ---- Results ----
    config = {
        "base_model": args.model,
        "dataset": "BigEarthNet.txt (official parquet + Encoded-BigEarthNet LMDB)",
        "types": types,
        "categories": categories,
        "eval_source": src,
        "subset_patches": train_ds.num_patches + (0 if args.eval_bench else len(eval_patches)),
        "train_patches": train_ds.num_patches,
        "train_annotations": len(train_samples),
        "eval_patches": len(eval_patches),
        "eval_pool_annotations": len(eval_pool),
        "eval_sample_size": len(base_eval),
        "lora_rank": args.lora_rank,
        "lora_alpha": args.lora_alpha,
        "lora_dropout": args.lora_dropout,
        "target_modules": target_modules,
        "training_steps": step,
        "learning_rate": args.learning_rate,
        "warmup_steps": args.warmup_steps,
        "batch_size": args.batch_size,
        "gradient_accumulation_steps": args.grad_accum,
        "effective_batch_size": effective_batch,
        "gradient_checkpointing": args.gradient_checkpointing,
        "max_length": args.max_length,
        "seed": args.seed,
        "training_dtype": str(dtype),
        "device": str(device),
        "base_accuracy": round(base_acc, 4),
        "adapted_accuracy": round(adapted_acc, 4),
        "delta": round(adapted_acc - base_acc, 4),
        "adapter_path": str(final_dir),
        "eval_metric": "lightweight exact-match (lowercased, repository-level)",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "checkpoints_saved": checkpoints_saved,
        "resumed_from": str(args.resume_from_checkpoint) if args.resume_from_checkpoint else None,
        "adapter_validation": adapter_info,
    }
    EVAL_FILE.write_text(json.dumps(config, indent=2))
    logger.info("Eval results -> %s", EVAL_FILE)

    logger.info("=== SUMMARY ===")
    logger.info("  Base accuracy:    %.4f", base_acc)
    logger.info("  Adapted accuracy: %.4f", adapted_acc)
    logger.info("  Delta:            %+.4f", adapted_acc - base_acc)


if __name__ == "__main__":
    main()