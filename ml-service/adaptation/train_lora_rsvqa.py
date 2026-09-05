#!/usr/bin/env python3
"""LoRA fine-tuning of Qwen2-VL-2B-Instruct on RSVQA-HR.

This script:
  1. Loads a subset of cpratikaki/RSVQA-HR_qwen_finetuning (train only)
  2. Holds out 10% of the subset for before/after evaluation
  3. Evaluates the base model on the held-out set
  4. Applies LoRA via Hugging Face peft — targeting Qwen2 language model
     self-attention q_proj and v_proj (28 layers)
  5. Runs a scoped training pass (default: 500 steps)
  6. Evaluates the adapted model on the same held-out set
  7. Saves the LoRA adapter to adaptation/checkpoint/
  8. Prints before/after accuracy (exact match, lowercased)

Usage:
  python3 adaptation/train_lora_rsvqa.py [--steps 500] [--subset 2000]

Output:
  adaptation/checkpoint/  — LoRA adapter files (load via PeftModel)
  adaptation/eval_results.json  — before/after numbers for README
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import torch
from datasets import load_dataset
from PIL import Image
from qwen_vl_utils import process_vision_info
from torch.utils.data import DataLoader, Dataset
from transformers import AutoProcessor, Qwen2VLForConditionalGeneration

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

BASE_MODEL  = "Qwen/Qwen2-VL-2B-Instruct"
DATASET_ID  = "cpratikaki/RSVQA-HR_qwen_finetuning"
ADAPTER_DIR = Path(__file__).parent / "checkpoint"
EVAL_FILE   = Path(__file__).parent / "eval_results.json"

LORA_RANK    = 16
LORA_ALPHA   = 32
LORA_DROPOUT = 0.05
# Target Qwen2 language model decoder self-attention q and v projections
# The model has 28 transformer layers in model.language_model.layers.*
TARGET_MODULES = ["q_proj", "v_proj"]

LR     = 3e-4
WARMUP = 50


class RSVQADataset(Dataset):
    """Dataset wrapper around RSVQA samples for Qwen2-VL training.

    Each item returns inputs dict with input_ids, attention_mask, pixel_values,
    image_grid_thw, and labels for supervised training.
    """

    def __init__(self, samples: list[dict], processor: AutoProcessor) -> None:
        self.samples   = samples
        self.processor = processor

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
        s = self.samples[idx]
        image = s["image"]
        if image.mode != "RGB":
            image = image.convert("RGB")

        question = s["question"]
        answer   = s["answer"].lower().strip()

        # Format as Qwen2-VL conversation
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": question},
                ],
            }
        ]

        # Apply chat template
        text = self.processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        image_inputs, video_inputs = process_vision_info(messages)

        # Tokenize inputs
        inputs = self.processor(
            text=[text],
            images=image_inputs,
            videos=video_inputs,
            padding="max_length",
            max_length=256,
            truncation=True,
            return_tensors="pt",
        )

        # Tokenize answer for labels
        answer_ids = self.processor.tokenizer(
            answer,
            padding="max_length",
            max_length=20,
            truncation=True,
            return_tensors="pt",
        )["input_ids"]

        # Replace padding with -100 so loss ignores them
        labels = answer_ids.clone()
        labels[labels == self.processor.tokenizer.pad_token_id] = -100

        return {
            "input_ids": inputs["input_ids"].squeeze(0),
            "attention_mask": inputs["attention_mask"].squeeze(0),
            "pixel_values": inputs["pixel_values"].squeeze(0),
            "image_grid_thw": inputs["image_grid_thw"].squeeze(0),
            "labels": labels.squeeze(0),
        }


def _infer(
    model: Qwen2VLForConditionalGeneration,
    processor: AutoProcessor,
    image: Image.Image,
    question: str,
    device: torch.device,
) -> str:
    """Run a single VQA inference and return decoded answer."""
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

    text = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
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

    output_ids = output_ids[:, inputs.input_ids.shape[1] :]
    return processor.batch_decode(output_ids, skip_special_tokens=True)[0].strip().lower()


def exact_match_accuracy(
    model: Qwen2VLForConditionalGeneration,
    processor: AutoProcessor,
    samples: list[dict],
    device: torch.device,
) -> tuple[float, int, int]:
    """Return (accuracy, total, n_correct) on exact-match lowercased comparison."""
    model.eval()
    correct = total = 0
    for s in samples:
        ref = s["answer"].lower().strip()
        pred = _infer(model, processor, s["image"], s["question"], device)
        if pred == ref:
            correct += 1
        total += 1
    return (correct / total if total else 0.0), total, correct


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=int, default=500, help="Training steps")
    parser.add_argument("--subset", type=int, default=2000, help="Total subset size")
    parser.add_argument("--batch", type=int, default=4, help="Batch size")
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    logger.info("Device: %s", device)

    logger.info("Loading base model: %s", BASE_MODEL)
    processor = AutoProcessor.from_pretrained(BASE_MODEL)
    model = Qwen2VLForConditionalGeneration.from_pretrained(
        BASE_MODEL,
        torch_dtype=torch.float32,
    ).to(device)

    logger.info("Loading RSVQA-HR subset — streaming %d samples...", args.subset)
    raw = load_dataset(DATASET_ID, split="train", streaming=True)
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

    n_eval = max(10, min(len(all_samples) // 10, len(all_samples) // 2))
    n_train = len(all_samples) - n_eval
    train_samples = all_samples[:n_train]
    eval_samples = all_samples[n_train:]
    logger.info("Train: %d  Eval: %d", n_train, n_eval)

    # ---- baseline evaluation ----
    logger.info("=== Evaluating BASE model (sample: first 20 from eval set) ===")
    base_acc, total, correct = exact_match_accuracy(
        model, processor, eval_samples[:20], device
    )
    logger.info("Base accuracy: %.4f (%d/%d)", base_acc, correct, total)

    # ---- apply LoRA ----
    logger.info(
        "=== Applying LoRA (rank=%d, target: language_model q_proj+v_proj) ===",
        LORA_RANK,
    )
    from peft import LoraConfig, get_peft_model

    lora_cfg = LoraConfig(
        r=LORA_RANK,
        lora_alpha=LORA_ALPHA,
        lora_dropout=LORA_DROPOUT,
        target_modules=TARGET_MODULES,
        bias="none",
    )
    model = get_peft_model(model, lora_cfg)
    model.print_trainable_parameters()

    # ---- training loop ----
    train_ds = RSVQADataset(train_samples, processor)
    train_loader = DataLoader(
        train_ds, batch_size=args.batch, shuffle=True, drop_last=True
    )

    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad], lr=LR
    )
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer, lambda s: min(1.0, s / WARMUP)
    )

    model.train()
    step = loss_sum = 0

    logger.info(
        "=== Training for %d steps (batch=%d lr=%.0e) ===",
        args.steps,
        args.batch,
        LR,
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

            if step % 50 == 0:
                logger.info(
                    "  step %4d/%d  loss=%.4f  lr=%.2e",
                    step,
                    args.steps,
                    loss_sum / 50,
                    optimizer.param_groups[0]["lr"],
                )
                loss_sum = 0.0

    logger.info("Training complete (%d steps)", step)

    # ---- adapted evaluation ----
    logger.info("=== Evaluating ADAPTED model (sample: first 20 from eval set) ===")
    adapted_acc, total, correct = exact_match_accuracy(
        model, processor, eval_samples[:20], device
    )
    logger.info("Adapted accuracy: %.4f (%d/%d)", adapted_acc, correct, total)

    # ---- save ----
    results = {
        "base_model": BASE_MODEL,
        "dataset": DATASET_ID,
        "subset_total": len(all_samples),
        "train_size": n_train,
        "eval_size": n_eval,
        "eval_sample_size": 20,
        "lora_rank": LORA_RANK,
        "lora_alpha": LORA_ALPHA,
        "lora_dropout": LORA_DROPOUT,
        "target_modules": TARGET_MODULES,
        "training_steps": step,
        "learning_rate": LR,
        "batch_size": args.batch,
        "base_accuracy": round(base_acc, 4),
        "adapted_accuracy": round(adapted_acc, 4),
        "delta": round(adapted_acc - base_acc, 4),
    }
    EVAL_FILE.write_text(json.dumps(results, indent=2))
    logger.info("Eval results → %s", EVAL_FILE)

    ADAPTER_DIR.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(ADAPTER_DIR))
    logger.info("LoRA adapter → %s", ADAPTER_DIR)

    logger.info("=== SUMMARY ===")
    logger.info("  Base accuracy:    %.4f", base_acc)
    logger.info("  Adapted accuracy: %.4f", adapted_acc)
    logger.info("  Delta:            %+.4f", adapted_acc - base_acc)


if __name__ == "__main__":
    main()
