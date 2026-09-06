#!/usr/bin/env python3
"""LoRA fine-tuning of Qwen2-VL-2B-Instruct on RSVQA-HR (Remote Sensing VQA).

This script:
  1. Loads a subset of cpratikaki/RSVQA-HR_qwen_finetuning (train split, streaming)
  2. Holds out a portion of the subset for before/after evaluation
  3. Evaluates the base model on the held-out set (lightweight exact match)
  4. Applies LoRA via Hugging Face peft — targeting Qwen2 language model
     self-attention q_proj and v_proj (28 layers)
  5. Runs a scoped training pass (default: 500 steps)
  6. Evaluates the adapted model on the same held-out set
  7. Saves PEFT-compatible LoRA adapter checkpoints
  8. Writes adaptation/eval_results.json

Usage:
  # Real training (validated config — do not run without explicit approval):
  python3 adaptation/train_lora_rsvqa.py

  # Tiny smoke test (real load/forward/backward/step):
  python3 adaptation/train_lora_rsvqa.py --steps 2 --subset 8 --batch-size 1

Output:
  adaptation/checkpoint/            — final LoRA adapter (PeftModel-loadable)
  adaptation/checkpoint/step-<n>/   — periodic intermediate adapters
  adaptation/eval_results.json      — before/after numbers for README
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger("train_lora_rsvqa")


def _check_required_deps() -> None:
    """Fail fast with a clear message if the heavy training stack is missing.

    Run before importing torch / PIL so the user sees a helpful message
    instead of a bare ImportError.
    """
    missing = []
    for mod in ("torch", "PIL", "datasets", "qwen_vl_utils", "peft", "transformers"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        logger.error(
            "Heavy training dependencies are not installed: %s. "
            "Install them with: pip install -r requirements-training.txt",
            ", ".join(missing),
        )
        sys.exit(2)


_check_required_deps()

import torch  # noqa: E402  (after dependency guard)
from PIL import Image  # noqa: E402

# Ensure ``ml-service`` is on sys.path so this script runs from any CWD and the
# torch-free helper module (adaptation/_train_helpers.py) stays importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from adaptation._train_helpers import build_masked_labels, split_train_eval  # noqa: E402

BASE_MODEL  = "Qwen/Qwen2-VL-2B-Instruct"
DATASET_ID  = "cpratikaki/RSVQA-HR_qwen_finetuning"
BASE_DIR    = Path(__file__).parent.resolve()
DEFAULT_OUT = BASE_DIR / "checkpoint"
EVAL_FILE   = BASE_DIR / "eval_results.json"

# Default LoRA hyperparameters (kept identical to the original pipeline).
LORA_RANK    = 16
LORA_ALPHA   = 32
LORA_DROPOUT = 0.05
# Target Qwen2 language model decoder self-attention q and v projections.
TARGET_MODULES = ["q_proj", "v_proj"]

LR     = 3e-4
WARMUP = 50


def seed_everything(seed: int) -> None:
    """Seed all relevant random generators for reproducibility.

    Note: full bit-for-bit reproducibility can still vary across hardware,
    CUDA kernel selection and cuDNN versions. This covers the sources we
    control (Python random, NumPy, torch, CUDA, and torch cuDNN heuristics).
    """
    random.seed(seed)
    try:
        import numpy as np
        np.random.seed(seed)
    except ImportError:
        pass
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
        # Deterministic-ish kernels where available.
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False


def resolve_device(override: str | None) -> torch.device:
    """Pick the best available device, with explicit MPS detection."""
    if override:
        return torch.device(override)
    if torch.cuda.is_available():
        return torch.device("cuda")
    # MPS is detected explicitly rather than silently treated as CPU.
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def resolve_dtype(device: torch.device) -> torch.dtype:
    """Choose a safe precision for the device.

    - CUDA: bf16 when supported, otherwise fp16
    - MPS / CPU: float32 (fp16/bf16 mixed precision is not used to avoid
      breaking Qwen2-VL or PEFT on these paths)
    """
    if device.type == "cuda":
        if torch.cuda.is_bf16_supported():
            return torch.bfloat16
        return torch.float16
    return torch.float32


def log_hardware(device: torch.device, dtype: torch.dtype) -> None:
    """Print a clear startup summary of the device / precision."""
    logger.info("Device: %s", device)
    logger.info("Dtype : %s", dtype)
    if device.type == "cuda":
        name = torch.cuda.get_device_name(device)
        vram = torch.cuda.get_device_properties(device).total_memory / (1024 ** 3)
        logger.info("GPU   : %s (%.1f GB VRAM)", name, vram)
    elif device.type == "mps":
        logger.info("GPU   : Apple Silicon (MPS)")


def validate_samples(samples: list[dict]) -> None:
    """Ensure every sample has the required RSVQA fields; fail clearly."""
    for i, s in enumerate(samples):
        for field in ("image", "question", "answer"):
            if field not in s or s[field] in (None, ""):
                raise ValueError(
                    f"Dataset sample {i} is missing required field '{field}'. "
                    f"Expected RSVQA fields: image, question, answer. "
                    f"Sample keys: {sorted(s.keys())}"
                )
        if not isinstance(s["image"], Image.Image):
            raise TypeError(
                f"Dataset sample {i}: 'image' must be a PIL.Image, got "
                f"{type(s['image']).__name__}"
            )


class RSVQADataset(torch.utils.data.Dataset):
    """Dataset wrapper around RSVQA samples for Qwen2-VL supervised fine-tuning.

    Each item returns inputs dict with input_ids, attention_mask, pixel_values,
    image_grid_thw, and labels. Labels are aligned to the FULL input sequence
    (prompt + answer) and only the assistant/answer tokens contribute to loss
    (all other positions are masked to -100).
    """

    def __init__(self, samples: list[dict], processor, max_length: int) -> None:
        self.samples = samples
        self.processor = processor
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
        s = self.samples[idx]
        image = s["image"]
        if image.mode != "RGB":
            image = image.convert("RGB")

        question = str(s["question"]).strip()
        answer = str(s["answer"]).strip()

        if not question:
            raise ValueError(f"Sample {idx} has an empty question.")
        if not answer:
            raise ValueError(f"Sample {idx} has an empty answer.")

        # ---- Build the conversation that the model will see during training.
        # The assistant turn carries the target answer: it must be part of the
        # sequence so the loss can be computed on it (causal LM).
        user_msg = {
            "role": "user",
            "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": question},
            ],
        }
        assistant_msg = {
            "role": "assistant",
            "content": [{"type": "text", "text": answer}],
        }

        # Prompt-only text (ends with the assistant header) used to locate the
        # first answer token. Because the image placeholder expansion is
        # identical in both tokenizations, the lengths cancel exactly.
        prompt_text = self.processor.apply_chat_template(
            [user_msg], tokenize=False, add_generation_prompt=True
        )
        full_text = self.processor.apply_chat_template(
            [user_msg, assistant_msg], tokenize=False, add_generation_prompt=False
        )
        image_inputs, video_inputs = process_vision_info([user_msg])

        # ---- Encode WITHOUT truncation or padding.
        # Qwen2-VL expands image placeholders into a per-image number of vision
        # tokens. Using truncation='max_length' (or padding='max_length') on the
        # multimodal call can cut those image tokens and trigger a
        # "Mismatch in image token count between text and input_ids" error.
        # We therefore never truncate the image region here and pad manually at
        # the tail (text/answer side) instead.
        full_inputs = self.processor(
            text=[full_text],
            images=image_inputs,
            videos=video_inputs,
            return_tensors="pt",
        )
        input_ids = full_inputs["input_ids"].squeeze(0)
        attention_mask = full_inputs["attention_mask"].squeeze(0)
        pixel_values = full_inputs["pixel_values"].squeeze(0)
        image_grid_thw = full_inputs["image_grid_thw"].squeeze(0)

        seq = input_ids.numel()
        if seq > self.max_length:
            # Refuse to silently truncate the image/answer: fail clearly instead
            # of producing a desynced loss (the exact bug we are preventing).
            raise ValueError(
                f"Sample {idx}: encoded sequence is {seq} tokens, which exceeds "
                f"--max-length {self.max_length}. The image tokens (+ answer) "
                f"must fit within max_length; increase --max-length."
            )

        # ---- Locate the start of the answer for loss masking (no truncation).
        prompt_inputs = self.processor(
            text=[prompt_text],
            images=image_inputs,
            videos=video_inputs,
            return_tensors="pt",
        )
        answer_start = prompt_inputs["input_ids"].shape[-1]

        # ---- Build labels aligned to the full (padded) input sequence.
        labels = build_masked_labels(
            input_ids.tolist(),
            answer_start=answer_start,
            pad_token_id=self.processor.tokenizer.pad_token_id,
            max_length=self.max_length,
        )

        # ---- Manual right-pad input_ids / attention_mask to max_length.
        pad_id = self.processor.tokenizer.pad_token_id
        if seq < self.max_length:
            pads = self.max_length - seq
            input_ids = torch.cat(
                [input_ids, torch.full((pads,), pad_id, dtype=input_ids.dtype)]
            )
            attention_mask = torch.cat(
                [
                    attention_mask,
                    torch.zeros((pads,), dtype=attention_mask.dtype),
                ]
            )

        return {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
            "pixel_values": pixel_values,
            "image_grid_thw": image_grid_thw,
            "labels": torch.tensor(labels, dtype=torch.long),
        }


def validate_first_sample(ds: RSVQADataset, device: torch.device, dtype: torch.dtype) -> None:
    """Log enough about the first training example to sanity-check preprocessing."""
    if len(ds) == 0:
        raise ValueError("Cannot validate: the training dataset is empty.")
    s = ds.samples[0]
    logger.info("=== Validating first training example ===")
    logger.info("  image exists : %s", s["image"] is not None)
    logger.info("  image size   : %sx%s mode=%s", *s["image"].size, s["image"].mode)
    logger.info("  question     : %r", str(s["question"])[:120])
    logger.info("  answer       : %r", str(s["answer"])[:120])
    item = ds[0]
    non_masked = int((item["labels"] != -100).sum())
    logger.info("  input_ids    : shape=%s dtype=%s", tuple(item["input_ids"].shape), item["input_ids"].dtype)
    logger.info("  labels       : shape=%s dtype=%s", tuple(item["labels"].shape), item["labels"].dtype)
    logger.info("  non-masked label tokens: %d", non_masked)
    logger.info("  pixel_values : shape=%s", tuple(item["pixel_values"].shape))
    logger.info("  image_grid_thw: shape=%s", tuple(item["image_grid_thw"].shape))
    logger.info("  device       : %s  dtype=%s", device, dtype)
    if non_masked == 0:
        raise RuntimeError(
            "Validation failed: zero non-masked label tokens for the first sample. "
            "The answer may be too long or truncated; check --max-length."
        )


def _infer(
    model,
    processor,
    image: Image.Image,
    question: str,
    device: torch.device,
) -> str:
    """Run a single VQA inference and return the decoded answer (lowercased)."""
    if image.mode != "RGB":
        image = image.convert("RGB")

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image},
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
        pred = _infer(model, processor, s["image"], str(s["question"]), device)
        if pred == ref:
            correct += 1
        total += 1
    return (correct / total if total else 0.0), total, correct


def select_eval_samples(samples: list[dict], n: int, seed: int) -> list[dict]:
    """Deterministically choose a stable eval sample list (for a given seed)."""
    if n <= 0:
        return []
    rng = random.Random(seed)
    if n >= len(samples):
        return list(samples)
    idx = rng.sample(range(len(samples)), n)
    return [samples[i] for i in sorted(idx)]


def validate_adapter_dir(adapter_dir: Path, model_name: str) -> dict:
    """Structurally verify a saved PEFT LoRA adapter without inference.

    Checks that the directory contains what the VQA loader
    (app/models/vlm_loader.py -> PeftModel.from_pretrained) expects.
    """
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
            "Adapter base model (%s) does not match training base model (%s); "
            "inference must load the SAME base model.",
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

    # Save adapter to a fresh temp sibling first, then move into place, so a
    # crash mid-write never leaves a corrupted partial checkpoint in the final
    # path. The adapter weights + adapter_config.json are what inference needs.
    out_dir = Path(out_dir)
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    tmp_dir = out_dir.parent / (out_dir.name + ".tmp")
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    model.save_pretrained(str(tmp_dir))
    if out_dir.exists():
        shutil.rmtree(out_dir)
    tmp_dir.rename(out_dir)

    # Best-effort: record what is expected by inference (non-fatal if unwritable).
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


def main() -> None:
    parser = argparse.ArgumentParser(
        description="LoRA fine-tune Qwen2-VL on RSVQA-HR (Remote Sensing VQA)"
    )
    parser.add_argument("--model", type=str, default=BASE_MODEL, help="HF base model id")
    parser.add_argument("--dataset", type=str, default=DATASET_ID, help="HF dataset id")
    parser.add_argument("--subset", type=int, default=2000, help="Total subset size (train+eval)")
    parser.add_argument("--holdout", type=int, default=200, help="Number of samples held out for eval")
    parser.add_argument("--batch-size", type=int, default=4, help="Training batch size")
    parser.add_argument("--steps", type=int, default=500, help="Number of training steps")
    parser.add_argument("--learning-rate", type=float, default=LR, help="AdamW learning rate")
    parser.add_argument("--warmup-steps", type=int, default=WARMUP, help="Linear warmup steps")
    parser.add_argument("--max-length", type=int, default=1024,
                        help="Max sequence length (image tokens + text). Must be large enough "
                             "to keep the answer from being truncated.")
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

    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")

    from datasets import load_dataset
    from qwen_vl_utils import process_vision_info
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

    # ---- Load / build dataset ----
    logger.info("Loading %s (streaming %d samples...)", args.dataset, args.subset)
    raw = load_dataset(args.dataset, split="train", streaming=True)
    all_samples: list[dict] = []
    for i, item in enumerate(raw):
        all_samples.append(
            {
                "image": item["image"],
                "question": item["question"],
                "answer": item["answer"],
            }
        )
        if i + 1 >= args.subset:
            break
    logger.info("Loaded %d samples", len(all_samples))
    validate_samples(all_samples)

    train_samples, eval_pool, n_train, n_eval = split_train_eval(
        all_samples, args.holdout
    )
    logger.info("Train: %d  Eval pool: %d", n_train, len(eval_pool))

    # ---- Baseline evaluation (BASE model, before LoRA) ----
    base_eval = select_eval_samples(eval_pool, args.eval_samples, args.seed)
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

    # ---- Training data ----
    train_ds = RSVQADataset(train_samples, processor, args.max_length)
    validate_first_sample(train_ds, device, dtype)

    train_loader = torch.utils.data.DataLoader(
        train_ds, batch_size=args.batch_size, shuffle=True, drop_last=True
    )

    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad], lr=args.learning_rate
    )
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer, lambda s: min(1.0, s / args.warmup_steps)
    )

    model.train()
    step = loss_sum = 0
    final_dir = args.output_dir
    checkpoints_saved: list[str] = []

    logger.info(
        "=== Training for %d steps (batch=%d lr=%.0e max_len=%d) ===",
        args.steps, args.batch_size, args.learning_rate, args.max_length,
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

            if input_ids.shape[-1] != labels.shape[-1]:
                raise RuntimeError(
                    f"Shape mismatch: input_ids {tuple(input_ids.shape)} vs "
                    f"labels {tuple(labels.shape)}. Labels must be aligned to the "
                    f"full input sequence."
                )

            outputs = model(
                input_ids=input_ids,
                attention_mask=attn_mask,
                pixel_values=pixel_vals,
                image_grid_thw=grid_thw,
                labels=labels,
            )
            loss = outputs.loss
            loss.backward()
            loss_sum += loss.item()

            optimizer.step()
            scheduler.step()
            optimizer.zero_grad()
            step += 1

            if args.save_every > 0 and step % args.save_every == 0:
                ckpt = args.output_dir / f"step-{step}"
                save_adapter(model, ckpt)
                checkpoints_saved.append(str(ckpt))
                logger.info("  saved checkpoint → %s", ckpt)

            if step % 50 == 0:
                logger.info(
                    "  step %4d/%d  loss=%.4f  lr=%.2e",
                    step, args.steps, loss_sum / 50, optimizer.param_groups[0]["lr"],
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
    logger.info("LoRA adapter → %s", final_dir)

    adapter_info = None
    try:
        adapter_info = validate_adapter_dir(final_dir, args.model)
    except Exception as exc:  # structural check should not silently pass
        logger.error("Adapter structural validation FAILED: %s", exc)
        adapter_info = None

    # ---- Results ----
    config = {
        "base_model": args.model,
        "dataset": args.dataset,
        "subset_total": len(all_samples),
        "train_size": n_train,
        "eval_size": n_eval,
        "eval_sample_size": len(base_eval),
        "lora_rank": args.lora_rank,
        "lora_alpha": args.lora_alpha,
        "lora_dropout": args.lora_dropout,
        "target_modules": target_modules,
        "training_steps": step,
        "learning_rate": args.learning_rate,
        "warmup_steps": args.warmup_steps,
        "batch_size": args.batch_size,
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
    logger.info("Eval results → %s", EVAL_FILE)

    logger.info("=== SUMMARY ===")
    logger.info("  Base accuracy:    %.4f", base_acc)
    logger.info("  Adapted accuracy: %.4f", adapted_acc)
    logger.info("  Delta:            %+.4f", adapted_acc - base_acc)


if __name__ == "__main__":
    main()
