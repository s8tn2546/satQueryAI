"""Regression tests for the BigEarthNet LoRA training collate path.

Qwen2-VL rejects the DataLoader's default collate for vision fields: stacking the
per-sample tensors adds a leading batch dimension (observed runtime error:
``ValueError: not enough values to unpack (expected 3, got 2)`` with shapes
``pixel_values (1, 128, 1176)`` and ``image_grid_thw (1, 2, 3)``).

The collate must instead produce the shapes the model forward pass expects:
  - ``pixel_values``   -> ``(total_image_tokens, hidden_dim)``
  - ``image_grid_thw`` -> ``(total_images, 3)``
across any batch size.  These tests pin that contract without loading the model.

Tests need torch (the pipeline core dependency) and are skipped where it is not
installed.  The ``bigearthnet_dataset`` module itself stays torch-free at import.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from adaptation.bigearthnet_dataset import collate_bigearthnet_batch


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