"""Focused tests for the LoRA training pipeline helpers (adaptation/).

These tests target the two defects found in the Colab smoke test:

1. Qwen2-VL multimodal token/label ALIGNMENT — the previous code used
   truncation/padding='max_length' on the multimodal processor call, which can
   cut image-feature tokens and trigger a "Mismatch in image token count between
   text and input_ids" error. The fix never truncates the image region and pads
   the tail manually, keeping input_ids/labels aligned.

2. SMALL-SUBSET SPLIT — the old split could report a negative train size or an
   eval size larger than the available samples. The fix guarantees a non-negative
   train size and that n_eval never exceeds available samples.

These tests are deliberately dependency-free (no torch / transformers / peft),
so they run in environments where the heavy training stack is not installed.
"""

from __future__ import annotations

import pytest

from adaptation._train_helpers import (
    IGNORE_INDEX,
    build_masked_labels,
    split_train_eval,
)

# ---------------------------------------------------------------------------
# Small-subset split
# ---------------------------------------------------------------------------


def _samples(n: int):
    return [{"image": i, "question": "q", "answer": "a"} for i in range(n)]


def test_split_small_subset_never_negative_or_oversized():
    """subset=8 with a large holdout must yield a valid small split."""
    samples = _samples(8)
    train, eval_pool, n_train, n_eval = split_train_eval(samples, holdout=200)

    assert n_train >= 1            # never negative / empty training
    assert n_eval <= len(samples)  # eval never exceeds available samples
    assert len(eval_pool) == n_eval
    assert n_train + n_eval == 8
    assert len(train) == n_train


@pytest.mark.parametrize(
    "total,holdout",
    [
        (8, 200),
        (8, 10),
        (8, 4),
        (1, 200),
        (0, 200),
        (2, 5),
        (100, 200),
        (100, 0),
    ],
)
def test_split_always_well_formed(total, holdout):
    samples = _samples(total)
    train, eval_pool, n_train, n_eval = split_train_eval(samples, holdout)

    assert n_train >= 0
    assert 0 <= n_eval <= total
    assert n_train <= total and n_eval <= total
    assert n_train + n_eval == total
    assert len(train) == n_train
    assert len(eval_pool) == n_eval
    # When there is more than one sample we keep at least one training sample.
    if total > 1:
        assert n_train >= 1


def test_split_keeps_order_and_does_not_mutate_input():
    samples = _samples(8)
    original = list(samples)
    train, eval_pool, _, _ = split_train_eval(samples, holdout=3)

    assert samples == original  # input not mutated
    assert train == samples[:5]
    assert eval_pool == samples[5:]


# ---------------------------------------------------------------------------
# Multimodal token / label alignment
# ---------------------------------------------------------------------------


def test_build_masked_labels_keeps_answer_only():
    """Prompt and right-padding are masked (-100); only answer tokens remain."""
    import random

    n_image = 300  # simulated image-feature token count
    rng = random.Random(0)
    answer_ids = [rng.randint(200, 3000) for _ in range(5)]
    pad_id = 151645

    full_ids = [777] * n_image + answer_ids
    answer_start = n_image

    labels = build_masked_labels(full_ids, answer_start, pad_id, max_length=512)

    assert len(labels) == 512
    assert labels[:n_image] == [IGNORE_INDEX] * n_image
    assert labels[n_image:n_image + 5] == answer_ids
    assert labels[n_image + 5:] == [IGNORE_INDEX] * (512 - n_image - 5)


def test_build_masked_labels_masks_pad_token_positions():
    """Tokens equal to pad_token_id anywhere are masked with -100."""
    pad_id = 151645
    full_ids = [10, 11, 12, 13, 14]
    labels = build_masked_labels(full_ids, answer_start=3, pad_token_id=pad_id,
                                 max_length=5)
    assert labels == [IGNORE_INDEX, IGNORE_INDEX, IGNORE_INDEX, 13, 14]


def test_build_masked_labels_no_truncation_of_image_region():
    """Image-feature tokens (the prompt prefix) are preserved, not truncated.

    This guards the exact bug where truncation='max_length' on the multimodal
    call cut the image region and desynced text-vs-input_ids image token counts.
    """
    # Simulate a Qwen2-VL encoding: image tokens occupy the prefix, then text.
    n_image = 380
    prompt_text_ids = [1, 2, 3]
    answer_ids = [4, 5, 6, 7]
    full_ids = [900] * n_image + prompt_text_ids + answer_ids
    pad_id = 151645
    # answer_start = position right after the (image + prompt text) prefix
    answer_start = n_image + len(prompt_text_ids)

    labels = build_masked_labels(full_ids, answer_start, pad_id, max_length=1024)

    # The image+prompt prefix is fully masked, the answer is the only signal.
    assert labels[:answer_start] == [IGNORE_INDEX] * answer_start
    assert labels[answer_start:answer_start + 4] == answer_ids
    assert len(labels) == 1024


def test_image_token_expansion_offset_is_exact():
    """Answer-start offset stays correct as the image token count scales.

    Models the Qwen2-VL placeholder expansion (image -> N vision tokens).
    The prompt-only and full encodings expand identically, so the offset equals
    the prompt length; labels must then align across different image sizes.
    """
    pad_id = 151645
    for n_image in (100, 241, 324, 500, 1024):
        full_ids = [900] * n_image + [7, 8, 9, 10]  # image + 4 answer tokens
        labels = build_masked_labels(full_ids, n_image, pad_id, max_length=2048)

        assert labels[n_image:n_image + 4] == [7, 8, 9, 10]
        non_masked = [t for t in labels if t != IGNORE_INDEX]
        assert non_masked == [7, 8, 9, 10]
