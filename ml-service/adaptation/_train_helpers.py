"""Pure, torch-free helpers for the LoRA training pipeline.

Kept dependency-free (no torch / transformers / datasets) so they can be unit
tested in lightweight CI environments where the heavy training stack is not
installed.

Two functions are covered here:

1. ``split_train_eval`` — safe training/eval split that can never produce a
   negative training size or an eval size larger than the available samples
   (important for tiny smoke-test subsets).

2. ``build_masked_labels`` — build a causal-LM labels sequence aligned to a
   full input_id sequence (prompt + answer) where everything before the answer
   start and all padding/``pad_token_id`` positions are masked with ``-100``.
   Only the assistant/answer tokens contribute to the supervised loss.
"""

from __future__ import annotations

from typing import List, Sequence, Tuple

# Sentinel used by HF for "ignore this position in the loss".
IGNORE_INDEX = -100


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
