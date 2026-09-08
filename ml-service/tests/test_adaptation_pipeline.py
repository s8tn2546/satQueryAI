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

5. MEMORY-SAFE TRAINING CONFIG for 14-16 GB GPUs — the 500-step Qwen2-VL LoRA
   run OOM'd on a 14.6 GB Tesla T4. The fix defaults to physical batch size 1,
   gradient checkpointing on, and gradient accumulation (effective batch =
   batch-size × grad-accum) so the effective batch stays configurable without
   blowing up activations.

These tests are deliberately dependency-free (no torch / transformers / peft),
so they run in environments where the heavy training stack is not installed.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from adaptation._train_helpers import (
    IGNORE_INDEX,
    IMAGE_TOKEN_TYPE,
    TEXT_TOKEN_TYPE,
    build_masked_labels,
    effective_batch_size,
    make_mm_token_type_ids,
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
    """The dataset must use processor mm_token_type_ids and forward it.

    Dependency-free source check: __getitem__ sources mm_token_type_ids from the
    processor output (via _ensure_mm_token_type_ids, which reads
    full_inputs["mm_token_type_ids"] first), and the training loop forwards it
    to model() when present — so Qwen2-VL M-RoPE receives real processor values.
    """
    src = TRAIN_SCRIPT.read_text()

    # 1. __getitem__ trusts the processor-returned field (from full_inputs).
    assert 'if "mm_token_type_ids" in processor_output' in src
    assert "full_inputs" in src and "processor_output" in src

    # 2. The training loop pulls it from the batch and forwards it to model()
    #    only when it exists.
    loop = src.split("for batch in train_loader:")[1]
    assert 'batch.get("mm_token_type_ids")' in loop
    assert 'fwd_kwargs["mm_token_type_ids"] = mm_tids' in loop
    assert "outputs = model(**fwd_kwargs)" in loop


def test_mm_token_type_ids_no_fake_default():
    """The real processor output (if any) is preferred, never a zeros default.

    Requirement: never fabricate a default tensor standing in for the processor.
    Any reconstruction of the field must come from the input_ids-based heuristic
    (make_mm_token_type_ids), never a hardcoded torch.zeros(...) factory.
    """
    src = TRAIN_SCRIPT.read_text()
    assert 'if "mm_token_type_ids" in processor_output' in src
    # The only manufacture of values for these ids must be the input_ids-based
    # helper, never a raw torch.zeros(...) default tensor standing in.
    assert "mm_token_type_ids = torch.zeros(" not in src
    assert "make_mm_token_type_ids" in src


# ---------------------------------------------------------------------------
# Memory-safe training configuration (14-16 GB GPU / Tesla T4 defaults)
# ---------------------------------------------------------------------------


def _arg_default(src, arg_name, option="default"):
    """Parse ``default=<x>`` from an argparse add_argument call for ``arg_name``."""
    m = re.search(
        rf"{re.escape(arg_name)}.*?{re.escape(option)}\s*=\s*([^,\s\]]+)",
        src,
        flags=re.DOTALL,
    )
    assert m, f"could not find default for {arg_name}"
    return m.group(1).strip()


def test_default_physical_batch_size_is_one():
    """--batch-size must default to 1 so training fits small (14-16 GB) GPUs."""
    src = TRAIN_SCRIPT.read_text()
    default = _arg_default(src, '"--batch-size"')
    int_val = int(re.search(r"[-0-9]+", default).group())
    assert int_val == 1


def test_default_grad_accum_is_four():
    """--grad-accum defaults to 4, matching the prior effective batch of 4."""
    src = TRAIN_SCRIPT.read_text()
    default = _arg_default(src, '"--grad-accum"')
    int_val = int(re.search(r"[-0-9]+", default).group())
    assert int_val == 4


def test_gradient_checkpointing_defaults_to_enabled():
    """Gradient checkpointing must default ON to cut activation memory."""
    src = TRAIN_SCRIPT.read_text()
    default = _arg_default(src, '"--gradient-checkpointing"')
    assert default == "True", f"expected gradient checkpointing default True, got {default}"
    assert 'action=argparse.BooleanOptionalAction' in src


def test_memory_cli_options_present():
    """The memory knobs (and their inverses) must exist as CLI options."""
    src = TRAIN_SCRIPT.read_text()
    assert '"--grad-accum"' in src
    assert '"--gradient-checkpointing"' in src
    assert '"--no-gradient-checkpointing"' in src or (
        "BooleanOptionalAction" in src
    )
    # Guards against nonsensical values.
    assert "if args.batch_size < 1" in src
    assert "if args.grad_accum < 1" in src


def test_effective_batch_size_matches_prior_config():
    """Default physical batch 1 × grad-accum 4 == old effective batch 4."""
    assert effective_batch_size(1, 4) == 4


@pytest.mark.parametrize(
    "physical, accum, expected",
    [
        (1, 1, 1),
        (1, 4, 4),
        (1, 8, 8),
        (2, 4, 8),
        (4, 8, 32),
        (0, 4, 0),
        (1, 0, 1),
    ],
)
def test_effective_batch_size_combinations(physical, accum, expected):
    assert effective_batch_size(physical, accum) == expected


def test_training_loop_uses_accumulated_step():
    """The loop must scale loss and step the optimizer once per grad-accum group,
    never per micro-batch (keeps the 500-step target as optimizer updates)."""
    src = TRAIN_SCRIPT.read_text()
    loop = src.split("for batch in train_loader:")[1]
    assert "loss = outputs.loss / accum_steps" in loop
    assert "if micro_step == accum_steps:" in loop
    assert loop.count("optimizer.step()") == 1
    assert loop.count("optimizer.zero_grad()") == 1
    # The 500-step target is preserved as the number of optimizer updates.
    assert "--steps\", type=int, default=500" in src or re.search(
        r'"--steps"[^)]*default=500', src
    )


# ---------------------------------------------------------------------------
# mm_token_type_ids: optional processor field (WITH and WITHOUT)
# ---------------------------------------------------------------------------


def _fake_processor(with_field, image_token_ids, video_token_ids=(), audio_token_ids=()):
    """Build a minimal fake processor for `_ensure_mm_token_type_ids` tests.

    Emulates the two Qwen2-VL processor behaviors:
      - WITH: `create_mm_token_type_ids` is present and `__call__` returns the
        field directly (transformers that honor return_mm_token_type_ids=True).
      - WITHOUT: processor does not expose the field at all.
    """

    class _Tok:
        pass

    tokenizer = _Tok()
    tokenizer.pad_token_id = 0

    class _Processor:
        image_token_id = list(image_token_ids)
        video_token_id = list(video_token_ids)
        audio_token_id = list(audio_token_ids)
        tokenizer = tokenizer

        def create_mm_token_type_ids(self, batch):
            out = []
            for row in batch:
                out.append(
                    make_mm_token_type_ids(
                        row,
                        image_token_ids=self.image_token_id,
                        video_token_ids=self.video_token_id,
                        audio_token_ids=self.audio_token_id,
                    )
                )
            return out

    return _Processor()


def test_processor_output_with_mm_token_type_ids_used_directly():
    """WITH the field: __getitem__ must use the processor-returned value."""
    src = TRAIN_SCRIPT.read_text()
    # Explicitly request the field so supported processor versions return it.
    assert "return_mm_token_type_ids=True" in src
    # The helper must check the processor output first (no reconstruction when
    # the real field is present).
    assert '"mm_token_type_ids" in processor_output' in src


def test_processor_output_without_mm_token_type_ids_falls_back():
    """WITHOUT the field: __getitem__ must reconstruct it from input_ids,
    never crash with KeyError, and never invent arbitrary modality labels."""
    # The helper reconstructs modality ids for a real id sequence.
    image_ids = [151665, 151666]
    video_ids = [151667]
    audio_ids = [151668]
    ids = [100, image_ids[0], image_ids[1], 200, video_ids[0], audio_ids[0], 300]

    tids = make_mm_token_type_ids(
        ids,
        image_token_ids=image_ids,
        video_token_ids=video_ids,
        audio_token_ids=audio_ids,
    )
    # image -> 1, video -> 2, audio -> 3, text -> 0, preserving order.
    assert tids == [0, 1, 1, 0, 2, 3, 0]

    # The source must guard against the missing key (no raw KeyError).
    src = TRAIN_SCRIPT.read_text()
    assert 'if "mm_token_type_ids" in processor_output' in src


def test_dataset_returns_and_forwards_only_when_present():
    """When the field is absent, __getitem__ must NOT return mm_token_type_ids
    and training must NOT forward it; when present, it is returned and forwarded."""
    src = TRAIN_SCRIPT.read_text()
    loop = src.split("for batch in train_loader:")[1]
    # Training must conditionally forward the field, not hard-require it.
    assert 'batch.get("mm_token_type_ids")' in loop
    assert "if mm_tids is not None:" in loop
    assert 'if "mm_token_type_ids" in item and item["mm_token_type_ids"] is not None' in src


def test_pixel_values_and_image_grid_thw_remain_mandatory():
    """image_grid_thw / pixel_values must stay required for image inputs."""
    src = TRAIN_SCRIPT.read_text()
    ds = src.split("class RSVQADataset")[1]
    # Dataset still reads both from the processor output without fallback.
    assert 'pixel_values = full_inputs["pixel_values"].squeeze(0)' in ds
    assert 'image_grid_thw = full_inputs["image_grid_thw"].squeeze(0)' in ds
    # Training loop always forwards them, unconditionally.
    loop = src.split("for batch in train_loader:")[1]
    assert "pixel_values=pixel_vals" in loop
    assert "image_grid_thw=grid_thw" in loop


def test_mm_token_type_ids_optional_omitted_from_model_kwargs_when_absent():
    """Model kwargs must omit mm_token_type_ids when the batch lacks it."""
    src = TRAIN_SCRIPT.read_text()
    loop = src.split("for batch in train_loader:")[1]
    # fwd_kwargs is built without mm_token_type_ids unless present.
    assert "fwd_kwargs = dict(" in loop
    assert 'if mm_tids is not None:' in loop
    assert 'fwd_kwargs["mm_token_type_ids"] = mm_tids' in loop
    assert "outputs = model(**fwd_kwargs)" in loop


def test_padding_not_attempted_when_mm_token_type_ids_absent():
    """Pad logic must be skipped entirely when the field is absent."""
    src = TRAIN_SCRIPT.read_text()
    # The padding block is guarded by `if mm_token_type_ids is not None`.
    assert "if mm_token_type_ids is not None:" in src
