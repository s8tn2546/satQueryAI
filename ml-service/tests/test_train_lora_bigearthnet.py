"""Regression tests for the BigEarthNet LoRA training data path.

1. SAMPLE SCHEMA: ``materialize()`` exposes canonical top-level ``s2_rgb`` /
   ``s1_rgb`` PIL RGB images that ``BigEarthNetQwenDataset.__getitem__`` reads,
   bypassing the old runtime error
   ``ValueError: Dataset sample 0 is missing required field 's2_rgb'.``

2. BATCHING: Qwen2-VL rejects the DataLoader's default collate for vision
   fields — stacking the per-sample tensors adds a leading batch dimension
   (observed runtime error: ``ValueError: not enough values to unpack
   (expected 3, got 2)`` with shapes ``pixel_values (1, 128, 1176)`` and
   ``image_grid_thw (1, 2, 3)``).

The collate must instead produce the shapes the model forward pass expects:
  - ``pixel_values``   -> ``(total_image_tokens, hidden_dim)``
  - ``image_grid_thw`` -> ``(total_images, 3)``
across any batch size.

These tests run the real dataset/``__getitem__``/collate stack with a fake Qwen
processor, so they prove the contract without loading a model.  Tests need torch
(and qwen-vl-utils) and are skipped where they are not installed; the
``bigearthnet_dataset`` module itself stays torch-free at import.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from adaptation.bigearthnet_dataset import collate_bigearthnet_batch

PAD_ID = 0
IMAGE_TOKEN = 151665
N_IMAGE_TOKENS = 8
PROMPT_TOKENS = 5
ANSWER_TOKENS = 4
HIDDEN = 1176
MAX_LEN = 512
FULL_SEQ = N_IMAGE_TOKENS + PROMPT_TOKENS + ANSWER_TOKENS
GRID = [[1, 4, 4], [1, 4, 4]]


def _make_materialized_sample(i: int) -> dict:
    """A ``BigEarthNetDataset.materialize()``-style sample (canonical fields)."""
    from PIL import Image

    s2 = Image.new("RGB", (16, 12), color=(10 * i, 20 * i, 30 * i))
    s1 = Image.new("RGB", (16, 12), color=(5 * i, 40 * i, 60 * i))
    return {
        "s2_rgb": s2,
        "s1_rgb": s1,
        "images": (s2, s1),
        "question": f"Question {i}?",
        "answer": f"answer {i}",
        "patch_id": f"PATCH_{i}",
        "type": "binary" if i % 2 == 0 else "mcq",
        "category": "land-cover",
        "split": "train",
        "ID": f"BEN0000000{i}",
    }


class _FakeTokenizer:
    pad_token_id = PAD_ID


class _FakeProcessor:
    """Minimal processor emulating the Qwen2-VL two-image encoding."""

    image_token_id = [IMAGE_TOKEN]
    video_token_id = [151667]
    audio_token_id = [151668]
    tokenizer = _FakeTokenizer()

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        return "FULL" if len(messages) == 2 else "PROMPT"

    def __call__(self, text=None, images=None, videos=None, return_tensors=None,
                 return_mm_token_type_ids=False):
        n_images = len(images or [])
        n = FULL_SEQ if return_mm_token_type_ids else N_IMAGE_TOKENS + PROMPT_TOKENS
        input_ids = [IMAGE_TOKEN] * N_IMAGE_TOKENS + [1] * PROMPT_TOKENS
        if return_mm_token_type_ids:
            input_ids += [2] * ANSWER_TOKENS
        out = {
            "input_ids": torch.tensor([input_ids], dtype=torch.long),
            "attention_mask": torch.ones(1, n, dtype=torch.long),
            "pixel_values": torch.rand(1, n_images * 4, HIDDEN, dtype=torch.float32),
            "image_grid_thw": torch.tensor([GRID], dtype=torch.long),
            "mm_token_type_ids": torch.tensor(
                [[1] * N_IMAGE_TOKENS + [0] * (n - N_IMAGE_TOKENS)],
                dtype=torch.long,
            ),
        }
        if not return_mm_token_type_ids:
            out.pop("mm_token_type_ids")
        return out


def _make_sample(
    n_image_tokens: int,
    *,
    n_images: int = 2,
    hidden: int = 1176,
    max_length: int = 1536,
    sample_seed: int = 0,
) -> dict:
    """Build one dataset-style sample (as returned by ``BigEarthNetQwenDataset``).

    ``pixel_values`` is ``(num_image_tokens, hidden_dim)``,
    ``image_grid_thw`` is ``(num_images, 3)``; text tensors are padded to
    ``max_length``.  Values are filled row-wise with the global row index so the
    collated output can be checked for order-preservation and exact concatenation.
    """
    pixel_values = torch.arange(
        n_image_tokens * hidden, dtype=torch.float32
    ).view(n_image_tokens, hidden)
    image_grid_thw = torch.arange(
        n_images * 3, dtype=torch.int64
    ).view(n_images, 3)
    seq = torch.arange(max_length, dtype=torch.long)
    return {
        "input_ids": seq + sample_seed,
        "attention_mask": torch.ones(max_length, dtype=torch.long),
        "pixel_values": pixel_values,
        "image_grid_thw": image_grid_thw,
        "labels": seq - 100 + sample_seed,
    }


def _assert_batch_contract(batch: dict, n_samples: int, hidden: int) -> None:
    """The shapes Qwen2-VL insists on, for any batch size."""
    total_images = n_samples * 2
    assert batch["pixel_values"].ndim == 2
    assert batch["pixel_values"].shape[1] == hidden
    assert batch["image_grid_thw"].ndim == 2
    assert batch["image_grid_thw"].shape[1] == 3
    assert batch["image_grid_thw"].shape[0] == total_images


def test_collate_batch_size_one_keeps_vision_shapes():
    """batch_size=1 must NOT stack a leading dim onto pixel_values/grid_thw."""
    batch = collate_bigearthnet_batch([_make_sample(128, hidden=1176)])

    _assert_batch_contract(batch, n_samples=1, hidden=1176)
    assert batch["pixel_values"].shape == (128, 1176)
    assert batch["image_grid_thw"].shape == (2, 3)
    assert batch["input_ids"].shape == (1, 1536)


def test_collate_batched_vision_shapes_with_equal_lengths():
    """Batching equal-length samples concatenates (no spurious batch dim)."""
    samples = [
        _make_sample(128, n_images=2, hidden=1176),
        _make_sample(128, n_images=2, hidden=1176),
    ]
    batch = collate_bigearthnet_batch(samples)

    _assert_batch_contract(batch, n_samples=2, hidden=1176)
    assert batch["pixel_values"].shape == (256, 1176)
    assert batch["image_grid_thw"].shape == (4, 3)
    # Text tensors are fixed-length, so they still stack on the batch dim.
    assert batch["input_ids"].shape == (2, 1536)
    assert batch["labels"].shape == (2, 1536)
    assert batch["attention_mask"].shape == (2, 1536)


def test_collate_variable_vision_lengths_concatenates():
    """Samples with different image-token counts must concatenate, not crash."""
    samples = [
        _make_sample(128, hidden=1176),
        _make_sample(240, hidden=1176),
    ]
    batch = collate_bigearthnet_batch(samples)

    _assert_batch_contract(batch, n_samples=2, hidden=1176)
    assert batch["pixel_values"].shape == (128 + 240, 1176)
    assert batch["image_grid_thw"].shape == (4, 3)


def test_collate_preserves_per_sample_values_and_order():
    """Concatenation must keep each sample's rows intact and in order."""
    n_img0, n_img1 = 16, 32
    hidden = 8
    s0 = _make_sample(n_img0, n_images=2, hidden=hidden, sample_seed=0)
    s1 = _make_sample(n_img1, n_images=2, hidden=hidden, sample_seed=100)
    batch = collate_bigearthnet_batch([s0, s1])

    # pixel_values rows: sample 0 first, then sample 1.
    assert torch.equal(batch["pixel_values"][:n_img0], s0["pixel_values"])
    assert torch.equal(batch["pixel_values"][n_img0:], s1["pixel_values"])
    # image_grid_thw rows: 2 rows per sample in batch order.
    assert torch.equal(batch["image_grid_thw"][:2], s0["image_grid_thw"])
    assert torch.equal(batch["image_grid_thw"][2:], s1["image_grid_thw"])
    # Text tensors stack per sample.
    assert torch.equal(batch["input_ids"][0], s0["input_ids"])
    assert torch.equal(batch["input_ids"][1], s1["input_ids"])
    assert torch.equal(batch["labels"][1], s1["labels"])


def test_collate_future_batch_sizes():
    """Batch size 4 still yields (total_tokens, hidden) and (total_images, 3)."""
    samples = [
        _make_sample(96 + i * 7, n_images=2, hidden=1176, sample_seed=i)
        for i in range(4)
    ]
    tokens = [96 + i * 7 for i in range(4)]
    got = collate_bigearthnet_batch(samples)

    _assert_batch_contract(got, n_samples=4, hidden=1176)
    assert got["pixel_values"].shape == (sum(tokens), 1176)
    assert got["image_grid_thw"].shape == (8, 3)
    assert got["input_ids"].shape == (4, 1536)


# ---------------------------------------------------------------------------
# Functional regression: materialized schema -> validate -> __getitem__ -> collate
# ---------------------------------------------------------------------------


def test_getitem_consumes_canonical_s2_rgb_s1_rgb_fields():
    """BigEarthNetQwenDataset.__getitem__ must accept materialized samples.

    Reads the canonical top-level ``s2_rgb`` / ``s1_rgb`` PIL images (this is
    the exact schema the old pipeline crashed on) and emits Qwen2-VL tensors.
    """
    pytest.importorskip("qwen_vl_utils")
    from adaptation.bigearthnet_dataset import BigEarthNetQwenDataset

    ds = BigEarthNetQwenDataset(
        [_make_materialized_sample(0)],
        _FakeProcessor(),
        max_length=MAX_LEN,
    )
    item = ds[0]

    assert item["input_ids"].shape == (MAX_LEN,)
    assert item["labels"].shape == (MAX_LEN,)
    assert item["attention_mask"].shape == (MAX_LEN,)
    assert item["pixel_values"].shape == (N_IMAGE_TOKENS, HIDDEN)
    assert item["image_grid_thw"].shape == (2, 3)
    assert item["mm_token_type_ids"].shape == (MAX_LEN,)

    # Image tokens (151665) + prompt prefix, only the answer (2s) contributes.
    assert torch.equal(item["input_ids"][:FULL_SEQ][:13], torch.tensor(
        [IMAGE_TOKEN] * N_IMAGE_TOKENS + [1] * PROMPT_TOKENS
    ))
    assert torch.equal(item["input_ids"][13:17], torch.full((4,), 2))
    assert torch.equal(item["labels"][:13], torch.full((13,), -100))
    assert torch.equal(item["labels"][13:17], torch.full((4,), 2))
    assert torch.equal(item["labels"][17:], torch.full((MAX_LEN - 17,), -100))


def test_validate_samples_accepts_materialized_samples():
    """validate_samples must accept exactly what materialize() emits."""
    from adaptation.bigearthnet_dataset import validate_samples

    samples = [_make_materialized_sample(i) for i in range(4)]
    validate_samples(samples)  # no raise


def test_end_to_end_collate_batch_sizes_1_2_4():
    """materialize -> validate_samples -> __getitem__ -> collate for 1/2/4.

    The full stack must produce ``(total_image_tokens, hidden)`` and
    ``(total_images, 3)`` vision tensors with no spurious batch dim, for batch
    sizes 1, 2 and 4.
    """
    pytest.importorskip("qwen_vl_utils")
    from adaptation.bigearthnet_dataset import (
        BigEarthNetQwenDataset,
        validate_samples,
    )

    samples = [_make_materialized_sample(i) for i in range(4)]
    validate_samples(samples)
    ds = BigEarthNetQwenDataset(samples, _FakeProcessor(), max_length=MAX_LEN)
    items = [ds[i] for i in range(len(samples))]

    for b in (1, 2, 4):
        batch = collate_bigearthnet_batch(items[:b])
        assert batch["pixel_values"].shape == (N_IMAGE_TOKENS * b, HIDDEN)
        assert batch["image_grid_thw"].shape == (2 * b, 3)
        assert batch["input_ids"].shape == (b, MAX_LEN)
        assert batch["labels"].shape == (b, MAX_LEN)
        assert batch["attention_mask"].shape == (b, MAX_LEN)