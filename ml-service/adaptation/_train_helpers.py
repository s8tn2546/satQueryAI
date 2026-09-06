"""Pure, torch-free helpers for the LoRA training pipeline.

Kept dependency-free (no torch / transformers / datasets) so they can be unit
tested in lightweight CI environments where the heavy training stack is not
installed.

Three functions are covered here:

1. ``split_train_eval`` — safe training/eval split that can never produce a
   negative training size or an eval size larger than the available samples
   (important for tiny smoke-test subsets).

2. ``build_masked_labels`` — build a causal-LM labels sequence aligned to a
   full input_id sequence (prompt + answer) where everything before the answer
   start and all padding/``pad_token_id`` positions are masked with ``-100``.
   Only the assistant/answer tokens contribute to the supervised loss.

3. ``pad_token_type_ids`` — right-pad the processor-returned ``mm_token_type_ids``
   to a target length so it stays exactly aligned with the manually right-padded
   ``input_ids``/``attention_mask``, without altering the multimodal region.

4. ``effective_batch_size`` — physical batch size times gradient-accumulation
   steps. Used so a memory-tight configuration (physical batch 1 on small GPUs)
   can still train with a larger effective batch per optimizer step.
"""

from __future__ import annotations

from typing import List, Sequence, Tuple

# Sentinel used by HF for "ignore this position in the loss".
IGNORE_INDEX = -100

# Qwen2-VL mm_token_type_ids convention: 0 = text/no modality, 1 = image.
TEXT_TOKEN_TYPE = 0
IMAGE_TOKEN_TYPE = 1


def split_train_eval(
    all_samples: Sequence,
    holdout: int,
) -> Tuple[List, List, int, int]:
    """Split a list of samples into (train, eval_pool, n_train, n_eval).

    Guarantees:
      - ``n_eval`` is in ``[0, total - 1]`` when ``total > 1`` (so ``n_train >= 1``).
      - ``n_eval`` never exceeds the number of available samples.
      - ``n_train`` is never negative.
      - eval_pool always has exactly ``n_eval`` elements.

    Args:
        all_samples: full sample list (train + eval).
        holdout:     requested number of eval samples (capped to a safe bound).

    Returns:
        (train_samples, eval_pool, n_train, n_eval)
    """
    total = len(all_samples)
    if total <= 1:
        # Nothing left to hold out; everything is training.
        return list(all_samples)[:], [], total, 0

    n_eval = min(holdout, total - 1)
    n_train = total - n_eval
    train = list(all_samples[:n_train])
    eval_pool = list(all_samples[n_train:])
    return train, eval_pool, n_train, n_eval


def build_masked_labels(
    input_ids: Sequence[int],
    answer_start: int,
    pad_token_id: int,
    max_length: int,
) -> List[int]:
    """Build a labels sequence aligned to the full ``input_ids`` sequence.

    - masks every position before ``answer_start`` with ``IGNORE_INDEX`` (-100)
    - masks every ``pad_token_id`` position (right padding) with -100
    - right-pads with -100 up to ``max_length`` so labels match input_ids length

    Args:
        input_ids:   full token id sequence (image-feature tokens + prompt +
                     assistant header + answer), as an integer sequence.
        answer_start: index of the first answer token (0-based).
        pad_token_id: the tokenizer's padding token id (also masked).
        max_length:   target sequence length for right-padding.

    Returns:
        labels list with the same effective length as the padded input_ids.
    """
    seq = len(input_ids)
    labels = [int(t) for t in input_ids]
    for i in range(min(answer_start, seq)):
        labels[i] = IGNORE_INDEX
    labels = [IGNORE_INDEX if t == pad_token_id else t for t in labels]
    if len(labels) < max_length:
        labels += [IGNORE_INDEX] * (max_length - len(labels))
    return labels


def pad_token_type_ids(
    token_type_ids: Sequence[int],
    max_length: int,
) -> List[int]:
    """Right-pad ``mm_token_type_ids`` to ``max_length`` without touching the
    multimodal region.

    Qwen2-VL needs ``mm_token_type_ids`` (per-token 0=text, 1=image) aligned to
    ``input_ids`` so multimodal RoPE (M-RoPE) is computed correctly. Because the
    dataset manually right-pads ``input_ids``/``attention_mask`` (never truncating
    the image region), the token-type ids must be padded to exactly the same
    length using the "text/no modality" value (0), preserving the image region
    (1) at the front.

    Args:
        token_type_ids: processor-returned mm_token_type_ids (integer sequence).
        max_length:     target sequence length.

    Returns:
        Padded list of length ``max_length``. If ``token_type_ids`` is already
        longer than ``max_length`` it is returned unchanged (the caller refuses
        to truncate the multimodal region before this point).
    """
    padded = [int(t) for t in token_type_ids]
    if len(padded) < max_length:
        padded += [TEXT_TOKEN_TYPE] * (max_length - len(padded))
    return padded


def effective_batch_size(physical_batch_size: int, grad_accum_steps: int) -> int:
    """Effective samples per optimizer step = physical batch × accumulation.

    Gradient accumulation lets a small physical batch (e.g. 1 on a 14-16 GB
    GPU) simulate a larger batch across multiple forward/backward passes, with
    one optimizer step after ``grad_accum_steps`` micro-batches.

    Args:
        physical_batch_size: micro-batch size fed to the model in one pass.
        grad_accum_steps:    number of micro-batches per optimizer step.

    Returns:
        The effective number of samples contributing to each optimizer step.
    """
    return abs(physical_batch_size) * max(grad_accum_steps, 1)
