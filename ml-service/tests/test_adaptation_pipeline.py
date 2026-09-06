"""Focused tests for the LoRA training pipeline helpers (adaptation/).

These tests target the defects found in the Colab smoke test:

1. Qwen2-VL multimodal token/label ALIGNMENT — the previous code used
   truncation/padding='max_length' on the multimodal processor call, which can
   cut image-feature tokens and trigger a "Mismatch in image token count between
   text and input_ids" error. The fix never truncates the image region and pads
   the tail manually, keeping input_ids/labels aligned.

2. SMALL-SUBSET SPLIT — the old split could report a negative train size or an
   eval size larger than the available samples. The fix guarantees a non-negative
   train size and that n_eval never exceeds available samples.

3. process_vision_info AVAILABILITY in the training script — the symbol was
   previously imported only inside main()'s local scope, causing a NameError in
   the module-level _infer() helper. It must be a module-level import.

4. mm_token_type_ids ALIGNMENT for Qwen2-VL multimodal RoPE (M-RoPE) — the
   processor-returned per-token modality ids must be preserved, right-padded to
   exactly the same sequence length as the manually padded input_ids, and passed
   to model(). Otherwise the model raises a ValueError about missing
   mm_token_type_ids when multimodal inputs are supplied.

These tests are deliberately dependency-free (no torch / transformers / peft),
so they run in environments where the heavy training stack is not installed.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from adaptation._train_helpers import (
    IGNORE_INDEX,
    IMAGE_TOKEN_TYPE,
    TEXT_TOKEN_TYPE,
    build_masked_labels,
    pad_token_type_ids,
    split_train_eval,
)

TRAIN_SCRIPT = Path(__file__).resolve().parents[1] / "adaptation" / "train_lora_rsvqa.py"

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


# ---------------------------------------------------------------------------
# process_vision_info import availability in the training script
# ---------------------------------------------------------------------------


def test_process_vision_info_is_module_level():
    """qwen-vl-utils' process_vision_info must be imported at module scope.

    _infer() and RSVQADataset.__getitem__ run outside main(); the previous code
    imported process_vision_info only inside main(), causing a NameError during
    BASE model evaluation. Both call sites and a module-level import must exist,
    and there must be no import nested inside main().
    """
    assert TRAIN_SCRIPT.exists(), f"training script not found: {TRAIN_SCRIPT}"
    src = TRAIN_SCRIPT.read_text()
    lines = src.splitlines()

    assert "from qwen_vl_utils import process_vision_info" in src

    def line_index(predicate):
        for i, line in enumerate(lines):
            if predicate(line):
                return i
        return -1

    import_idx = line_index(
        lambda l: "from qwen_vl_utils import process_vision_info" in l
    )
    main_idx = line_index(lambda l: l.startswith("def main("))
    assert import_idx != -1, "module-level import missing"
    assert main_idx != -1
    assert import_idx < main_idx, (
        "process_vision_info import must be at module level (before main), "
        "not nested in main()'s local scope"
    )

    # The two call sites that previously NameError'd still reference the symbol.
    assert "process_vision_info([user_msg])" in src       # RSVQADataset.__getitem__
    assert "process_vision_info(messages)" in src         # _infer()


# ---------------------------------------------------------------------------
# mm_token_type_ids alignment (Qwen2-VL multimodal RoPE / M-RoPE)
# ---------------------------------------------------------------------------


def test_pad_token_type_ids_matches_input_ids_length():
    """Padded mm_token_type_ids must match the manually padded input sequence.

    The dataset manual-pads input_ids/attention_mask to max_length; token-type
    ids must be padded to exactly the same length so M-RoPE stays aligned.
    """
    seq = 7
    max_length = 16
    token_type_ids = [IMAGE_TOKEN_TYPE] * 4 + [TEXT_TOKEN_TYPE] * (seq - 4)
    padded = pad_token_type_ids(token_type_ids, max_length)
    assert len(padded) == max_length
    assert len(padded) == max_length  # == padded input_ids length


def test_pad_token_type_ids_preserves_multimodal_region():
    """Image tokens (value 1) at the front must be untouched by padding."""
    image_tokens = 5
    total_seq = 12
    token_type_ids = [IMAGE_TOKEN_TYPE] * image_tokens + [TEXT_TOKEN_TYPE] * (
        total_seq - image_tokens
    )
    padded = pad_token_type_ids(token_type_ids, max_length=20)
    assert padded[:image_tokens] == [IMAGE_TOKEN_TYPE] * image_tokens
    assert padded[image_tokens:total_seq] == [TEXT_TOKEN_TYPE] * (
        total_seq - image_tokens
    )
    # Everything beyond the original sequence is the "no modality" pad value.
    assert padded[total_seq:] == [TEXT_TOKEN_TYPE] * (20 - total_seq)


def test_pad_token_type_ids_does_not_alter_original_values():
    """Padding must not rewrite any value inside the original region."""
    token_type_ids = [1, 1, 0, 0, 1, 0, 1, 1, 0, 0]
    original = list(token_type_ids)
    padded = pad_token_type_ids(token_type_ids, max_length=25)
    assert padded[: len(original)] == original
    assert len(padded) == 25
    assert all(v in (TEXT_TOKEN_TYPE, IMAGE_TOKEN_TYPE) for v in padded)


def test_pad_token_type_ids_no_padding_when_already_long():
    """If the sequence already fits, it must be returned unchanged."""
    token_type_ids = [IMAGE_TOKEN_TYPE, TEXT_TOKEN_TYPE, TEXT_TOKEN_TYPE]
    assert pad_token_type_ids(token_type_ids, max_length=3) == token_type_ids
    assert pad_token_type_ids(token_type_ids, max_length=2) == token_type_ids


def test_mm_token_type_ids_is_returned_by_dataset_and_forwarded():
    """The dataset must return mm_token_type_ids and training must forward it.

    Dependency-free source check: __getitem__'s return dict must include
    mm_token_type_ids, and the model(...) call in the training loop must pass
    mm_token_type_ids=... so Qwen2-VL M-RoPE receives real processor values.
    """
    src = TRAIN_SCRIPT.read_text()

    # 1. __getitem__ reads it from the processor output and returns it.
    assert '"mm_token_type_ids": mm_token_type_ids' in src or (
        "'mm_token_type_ids': mm_token_type_ids" in src
    )
    assert '"mm_token_type_ids"][0]' in src or "full_inputs[\"mm_token_type_ids\"]" in src

    # 2. The training loop pulls it from the batch and forwards it to model().
    loop = src.split("for batch in train_loader:")[1]
    assert "mm_token_type_ids=mm_tids" in loop
    assert 'batch["mm_token_type_ids"]' in loop


def test_mm_token_type_ids_no_fake_default():
    """The real processor output (full_inputs["mm_token_type_ids"]) is used.

    Requirement: never fabricate a default tensor when the processor provides
    the real values. The dataset must source token-type ids from the processor
    output dict, not from a hardcoded zeros factory.
    """
    src = TRAIN_SCRIPT.read_text()
    assert 'full_inputs["mm_token_type_ids"]' in src
    # The only manufacture of values for these ids must be the pad helper, never
    # a raw torch.zeros(...) default tensor standing in for the processor.
    assert "mm_token_type_ids = torch.zeros(" not in src
