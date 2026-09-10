"""BigEarthNet.txt -> Qwen2-VL training data loader (Kaggle training workspace).

This module is part of the BigEarthNet.txt LoRA adaptation pipeline and lives
entirely on the *training* side.  It provides:

  1. ``BENImageReader`` — direct read-only access to the official
     ``Encoded-BigEarthNet`` LMDB (Sentinel-1 + Sentinel-2 safetensor band
     stacks) using the same S1<->S2 patch mapping the official
     ``ben_txt_datamodule.py`` builds from the BigEarthNet.txt parquet.

  2. ``bands_to_rgb_s2`` / ``bands_to_rgb_s1`` — scientifically standard
     false-color RGB composites so the official 12-channel ``S1S2-10m20m``
     tensor can be represented with TWO RGB images that Qwen2-VL can
     legitimately consume (Qwen2-VL accepts PIL RGB only):
       - S2 false color:  R = B08 (NIR), G = B04 (Red), B = B03 (Green)
       - S1 composite:    R = VV,        G = VH,       B = VV/VH ratio

  3. ``BigEarthNetDataset`` — parquet + LMDB accessor that produces
     per-annotation training samples carrying the two PIL RGB images (as
     canonical top-level ``s2_rgb`` / ``s1_rgb`` fields, plus a
     backward-compatible ``images`` tuple), the instruction and the reference
     answer (binary / mcq support).

  4. ``build_qwen_conversation`` — builds the Qwen2-VL chat-template messages
     with two image entries and one text instruction, ready for the processor.

  5. ``split_patches_no_leakage`` — train/eval split at the *image pair* level
     so multiple annotations of the same patch never cross the split boundary.

  6. ``run_preflight`` — pre-training sanity checks (also exposed as a CLI).
     Fails clearly with actionable instructions when the official LMDB imagery
     is absent.  It NEVER falls back to metadata-only or synthetic imagery.

  7. ``BigEarthNetQwenDataset`` — torch ``Dataset`` turning materialized
     samples into Qwen2-VL ``input_ids`` / ``attention_mask`` / ``pixel_values``
     / ``image_grid_thw`` / ``labels`` tensors, and ``collate_bigearthnet_batch``
     to assemble batches without a spurious vision batch dimension.

Module hygiene:
  * No ``torch`` / ``transformers`` imports REQUIRED at module level (torch is
    imported lazily/optionally), so the compositing + split + preflight helpers
    can be unit tested and ``py_compile``-checked in lightweight environments.
  * ``pandas`` / ``lmdb`` / ``safetensors`` are imported lazily inside the
    methods that need them.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path
from typing import Callable, Iterable, Optional

import numpy as np
from PIL import Image

try:
    import torch
except ImportError:  # keep the module importable in lightweight environments
    torch = None

from adaptation._train_helpers import (
    build_masked_labels,
    make_mm_token_type_ids,
    pad_token_type_ids,
)

# ---------------------------------------------------------------------------
# BigEarthNet.txt constants (verified against the official parquet schema)
# ---------------------------------------------------------------------------

# Official band names (BigEarthNet v2.0).  ``_s2_bandnames`` as in the
# official ben_txt_datamodule.py; ``S2-10m20m`` excludes the 60m bands.
S1_BANDS = ["VV", "VH"]
S2_FULL_BANDS = ["B01", "B02", "B03", "B04", "B05", "B06", "B07",
                 "B08", "B8A", "B09", "B11", "B12"]
S2_10M20M_BANDS = ["B02", "B03", "B04", "B05", "B06", "B07", "B08",
                   "B8A", "B11", "B12"]
# The official predefined combination used for this pipeline.
S1S2_10M20M = S1_BANDS + S2_10M20M_BANDS

# Bands needed by each composite.
S2_COMPOSITE_BANDS = {"B08", "B04", "B03"}   # R=B08(NIR) G=B04(Red) B=B03(Green)
S1_COMPOSITE_BANDS = {"VV", "VH"}           # R=VV G=VH B=VV/VH

# The BigEarthNet.txt parquet columns (official _expected_columns).
REQUIRED_PARQUET_COLUMNS = {
    "s1_name", "output", "longitude", "country", "climate_zone", "type",
    "input", "split", "latitude", "ID", "patch_id", "category", "season",
}

SUPPORTED_TYPES = {"binary", "mcq"}   # initial scope (captioning/bbox later)
SUPPORTED_SPLITS = {"train", "validation", "test", "bench"}

# ---------------------------------------------------------------------------
# Errors — every failure is explicit and actionable; no silent fallback.
# ---------------------------------------------------------------------------


class BigEarthNetError(Exception):
    """Base error for the BigEarthNet.txt pipeline."""


class BigEarthNetDataError(BigEarthNetError):
    """Parquet/metadata problem (missing columns, no rows after filtering)."""


class ImageryNotAvailableError(BigEarthNetError):
    """Official Encoded-BigEarthNet LMDB imagery cannot be read.

    Raised instead of falling back to synthetic/metadata-only imagery.
    """


class BandNotFoundError(BigEarthNetError):
    """A required band is missing from an LMDB safetensor stack."""


class PreflightError(BigEarthNetError):
    """One or more preflight checks failed; training cannot start."""


# ---------------------------------------------------------------------------
# Band -> RGB compositing (raw values, percentile-normalized per image)
# ---------------------------------------------------------------------------


def percentile_normalize(
    band,
    low: float = 2.0,
    high: float = 98.0,
) -> np.ndarray:
    """Normalize a single band array into ``[0, 1]`` with safe constant handling.

    Uses the ``low``->``high`` percentile of *finite* values for the stretch.
    Returns ``0.5`` (mid-gray) for any position that is non-finite, and for a
    constant channel (``hi - lo <= 0``) so we never divide by zero or emit
    NaN/Inf into the RGB composite.

    Args:
        band:  2-D array of raw band values (float or int dtype).
        low:   Lower percentile for the stretch.
        high:  Upper percentile for the stretch.

    Returns:
        Float array in ``[0, 1]`` with the same shape as ``band``.
    """
    arr = np.asarray(band, dtype=np.float64)
    if arr.ndim != 2:
        raise ValueError(
            f"percentile_normalize expects a 2-D band, got shape {arr.shape}"
        )
    if arr.size == 0:
        return np.zeros_like(arr)
    finite = arr[np.isfinite(arr)]
    if finite.size == 0:
        # No valid pixels at all -> neutral gray, do not fabricate signal.
        return np.full_like(arr, 0.5)
    lo = float(np.percentile(finite, low))
    hi = float(np.percentile(finite, high))
    span = hi - lo
    if span <= 0.0:
        # Constant channel: carries no information; use neutral gray safely.
        return np.full_like(arr, 0.5)
    out = (arr - lo) / span
    out[~np.isfinite(out)] = 0.5
    out = np.clip(out, 0.0, 1.0)
    return out


def _require_bands(bands: dict, needed: set[str], composite_name: str) -> None:
    missing = sorted(needed - set(bands))
    if missing:
        raise BandNotFoundError(
            f"{composite_name}: missing required band(s) {missing}. "
            f"LMDB stack for this patch contains: {sorted(bands)}"
        )


def bands_to_rgb_s2(bands: dict) -> Image.Image:
    """Sentinel-2 false-color RGB: R=B08(NIR), G=B04(Red), B=B03(Green).

    The classic agriculture/vegetation composite — vegetation appears bright
    red, water dark blue, bare soil cyan/brown.
    """
    _require_bands(bands, S2_COMPOSITE_BANDS, "S2 false-color")
    nir = percentile_normalize(bands["B08"])
    red = percentile_normalize(bands["B04"])
    green = percentile_normalize(bands["B03"])
    rgb = np.stack([nir, red, green], axis=-1)
    return Image.fromarray((rgb * 255.0).astype(np.uint8).round(), "RGB")


def bands_to_rgb_s1(bands: dict) -> Image.Image:
    """Sentinel-1 composite: R=VV, G=VH, B=VV/VH ratio.

    Standard SAR analysis composite: rough surfaces (urban/forest) are bright,
    smooth surfaces (water/roads) are dark; the ratio band encodes scattering
    mechanism differences.  Each channel is percentile-normalized.
    """
    _require_bands(bands, S1_COMPOSITE_BANDS, "S1 composite")
    vv = np.asarray(bands["VV"], dtype=np.float64)
    vh = np.asarray(bands["VH"], dtype=np.float64)
    if vv.shape != vh.shape:
        raise BandNotFoundError(
            f"S1 composite: VV {vv.shape} and VH {vh.shape} must share the same shape"
        )
    safe_vh = np.where(vh == 0.0, np.nan, vh)
    ratio = np.where(np.isfinite(safe_vh) & np.isfinite(vv), vv / safe_vh, np.nan)
    ratio = np.nan_to_num(ratio, nan=0.0)
    rgb = np.stack(
        [
            percentile_normalize(vv),
            percentile_normalize(vh),
            percentile_normalize(ratio),
        ],
        axis=-1,
    )
    return Image.fromarray((rgb * 255.0).astype(np.uint8).round(), "RGB")


# ---------------------------------------------------------------------------
# LMDB reader (self-contained; mirrors the official BENImageReader access, but
# returns RAW per-band arrays instead of a normalized z-scored tensor).
# ---------------------------------------------------------------------------


class BENImageReader:
    """Read-only access to the official Encoded-BigEarthNet LMDB.

    The LMDB houses BigEarthNet v2.0 patches as safetensors blobs:
      - key = ``patch_id``  -> Sentinel-2 band stack (one entry per band)
      - key = ``s1_name``   -> Sentinel-1 band stack (VV / VH)

    ``Parquet`` columns ``patch_id`` + ``s1_name`` provide the S1<->S2 mapping
    (identical to the official ``BENImageReader``).
    """

    def __init__(
        self,
        lmdb_dir: str | Path,
        parquet_path: Optional[str | Path] = None,
        img_size: int = 120,
        upsample_mode: str = "nearest",
    ) -> None:
        self.lmdb_dir = Path(lmdb_dir)
        self.img_size = int(img_size)
        self.upsample_mode = str(upsample_mode)
        self.env = None
        self.mapping: Optional[dict[str, str]] = None
        if parquet_path is not None:
            self.load_mapping(Path(parquet_path))

    # -- setup ------------------------------------------------------------

    def load_mapping(self, parquet_path: Path) -> None:
        """Build ``patch_id -> s1_name`` from the official parquet."""
        import pandas as pd

        if not parquet_path.exists():
            raise BigEarthNetDataError(
                f"BigEarthNet.txt parquet not found: {parquet_path}"
            )
        df = pd.read_parquet(parquet_path)
        missing = REQUIRED_PARQUET_COLUMNS - set(df.columns)
        if missing:
            raise BigEarthNetDataError(
                f"Parquet {parquet_path} is missing required columns: "
                f"{sorted(missing)}"
            )
        self.mapping = dict(zip(df["patch_id"].astype(str), df["s1_name"].astype(str)))

    def _resize(self, arr: np.ndarray) -> np.ndarray:
        """Resize a 2-D band to ``img_size`` x ``img_size`` (official default nearest)."""
        arr = np.asarray(arr, dtype=np.float32)
        if arr.ndim == 1:
            raise BigEarthNetError(
                f"Band array is 1-D (shape {arr.shape}); expected a 2-D raster band"
            )
        if arr.shape[:2] == (self.img_size, self.img_size):
            return arr
        img = Image.fromarray(arr)
        if self.upsample_mode == "bilinear":
            resample = Image.BILINEAR
        elif self.upsample_mode == "bicubic":
            resample = Image.BICUBIC
        else:
            resample = Image.NEAREST
        img = img.resize((self.img_size, self.img_size), resample)
        return np.asarray(img, dtype=np.float32)

    def open_env(self) -> None:
        """Open the LMDB environment lazily with an explicit, actionable error."""
        if self.env is not None:
            return
        if not self.lmdb_dir.exists():
            raise ImageryNotAvailableError(
                "Official BigEarthNet v2.0 imagery (Encoded-BigEarthNet LMDB) is "
                f"ABSENT: {self.lmdb_dir} does not exist.\n"
                "Training cannot start without the real S1/S2 imagery. Obtain it by:\n"
                "  1. Accept the official 'BigEarthNet v2.0 Encoded-BigEarthNet' "
                "dataset volume on Kaggle and point --lmdb at the unpacked "
                "Encoded-BigEarthNet directory, OR\n"
                "  2. Converting the BigEarthNet v2.0 S1/S2 GeoTIFFs with the "
                "official rico-hdl pipeline (https://github.com/kai-tub/rico-hdl) "
                "into the same LMDB+safetensors layout.\n"
                "There is NO metadata-only or synthetic fallback in this pipeline."
            )
        import lmdb

        if not (self.lmdb_dir / "data.mdb").exists():
            raise ImageryNotAvailableError(
                f"Encoded-BigEarthNet directory {self.lmdb_dir} exists but "
                "contains no data.mdb — it does not look like the official LMDB."
            )
        try:
            self.env = lmdb.open(
                str(self.lmdb_dir),
                readonly=True,
                lock=False,
                meminit=False,
                readahead=True,
                map_size=8 * 1024**3,
                max_spare_txns=16,
            )
        except Exception as exc:  # lmdb.Error surfaces on corrupt/locked envs
            raise ImageryNotAvailableError(
                f"Failed to open LMDB at {self.lmdb_dir}: {exc!r}"
            ) from exc
        if self.env.stat()["entries"] == 0:
            raise ImageryNotAvailableError(
                f"LMDB at {self.lmdb_dir} is empty (0 entries) — the official "
                "Encoded-BigEarthNet volume is required."
            )

    def close(self) -> None:
        if self.env is not None:
            try:
                self.env.sync()
                self.env.close()
            finally:
                self.env = None

    # -- access ------------------------------------------------------------

    def get_bands(self, key: str) -> dict[str, np.ndarray]:
        """Return ``{band_name: (img_size, img_size) float32}`` for one LMDB key."""
        import lmdb
        from safetensors.numpy import load as safetensor_load

        self.open_env()
        if not self.mapping:
            raise BigEarthNetDataError(
                "Reader has no S1/S2 mapping. Pass --parquet (or call load_mapping)."
            )
        assert self.env is not None
        with self.env.begin(write=False, buffers=True) as txn:
            raw = txn.get(key.encode())
        if raw is None:
            raise ImageryNotAvailableError(
                f"LMDB has no entry for '{key}' — this patch is not present in "
                "the Encoded-BigEarthNet volume."
            )
        try:
            stack = safetensor_load(bytes(raw))
        except Exception as exc:  # corrupt blob
            raise ImageryNotAvailableError(
                f"LMDB entry '{key}' is not a valid safetensors blob: {exc!r}"
            ) from exc
        return {name: self._resize(ary) for name, ary in stack.items()}

    def read_pair(self, patch_id: str) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
        """Return ``(s1_bands, s2_bands)`` for a given S2 ``patch_id``."""
        if self.env is None:
            self.open_env()
        if not self.mapping:
            raise BigEarthNetDataError(
                "Reader has no S1/S2 mapping. Pass --parquet (or call load_mapping)."
            )
        s1_key = self.mapping.get(patch_id)
        if s1_key is None:
            raise BigEarthNetDataError(
                f"patch_id '{patch_id}' has no s1_name mapping in the parquet."
            )
        s2_bands = self.get_bands(patch_id)
        s1_bands = self.get_bands(s1_key)
        return s1_bands, s2_bands


# ---------------------------------------------------------------------------
# Dataset (parquet + LMDB -> training samples)
# ---------------------------------------------------------------------------


class BigEarthNetDataset:
    """BigEarthNet.txt parquet + Encoded-BigEarthNet LMDB accessor.

    Yields per-annotation samples:  two PIL RGB images (S2 false-color, S1
    composite), the instruction, and the reference answer.  Filtering happens
    at parquet read time; a deterministic ``subset`` (in *unique image
    pairs*/patches) keeps memory bounded.  Images are loaded lazily on first
    access per patch and cached so multiple annotations of the same patch share
    one LMDB read.
    """

    def __init__(
        self,
        parquet_path: str | Path,
        lmdb_dir: str | Path,
        *,
        types: Iterable[str] = ("binary", "mcq"),
        splits: Iterable[str] = ("train",),
        categories: Optional[Iterable[str]] = None,
        subset: Optional[int] = None,
        seed: int = 42,
        img_size: int = 120,
        upsample_mode: str = "nearest",
        annotations_per_patch: int = 0,
    ) -> None:
        import pandas as pd

        self.parquet_path = Path(parquet_path)
        self.lmdb_dir = Path(lmdb_dir)
        self.seed = int(seed)
        self.img_size = int(img_size)

        if not self.parquet_path.exists():
            raise BigEarthNetDataError(
                f"BigEarthNet.txt parquet not found: {self.parquet_path}. "
                "Training cannot start without it."
            )

        df = pd.read_parquet(self.parquet_path)
        missing = REQUIRED_PARQUET_COLUMNS - set(df.columns)
        if missing:
            raise BigEarthNetDataError(
                f"Parquet is missing required columns: {sorted(missing)}"
            )

        types = list(types)
        unknown_types = set(types) - SUPPORTED_TYPES
        if unknown_types:
            raise BigEarthNetDataError(
                f"Unsupported annotation type(s) {sorted(unknown_types)}. "
                f"Supported initially: {sorted(SUPPORTED_TYPES)}."
            )
        df = df[df["type"].isin(types)]

        splits = list(splits)
        unknown_splits = set(splits) - SUPPORTED_SPLITS
        if unknown_splits:
            raise BigEarthNetDataError(
                f"Unsupported split(s) {sorted(unknown_splits)}. "
                f"Supported: {sorted(SUPPORTED_SPLITS)}."
            )
        df = df[df["split"].isin(splits)]

        if categories:
            df = df[df["category"].isin(categories)]

        if len(df) == 0:
            raise BigEarthNetDataError(
                f"No BigEarthNet.txt annotations match types={types}, "
                f"splits={splits}, categories={categories} in {self.parquet_path}."
            )

        self._annotations_per_patch = int(annotations_per_patch)
        self.reader = BENImageReader(self.lmdb_dir, self.parquet_path, img_size, upsample_mode)

        # Group by patch_id (unique image pair) to enable no-leakage splitting
        # and on-demand image loading shared across a patch's annotations.
        self.patches: list[dict] = []
        for pid, grp in df.groupby("patch_id"):
            rows = grp.sort_values("ID").reset_index(drop=True)
            if self._annotations_per_patch > 0:
                rows = rows.head(self._annotations_per_patch)
            self.patches.append(
                {
                    "patch_id": str(pid),
                    "s1_name": str(grp["s1_name"].iloc[0]),
                    "rows": [
                        {
                            "input": str(r["input"]),
                            "output": str(r["output"]),
                            "type": str(r["type"]),
                            "category": str(r["category"]),
                            "split": str(r["split"]),
                            "ID": str(r["ID"]),
                        }
                        for _, r in rows.iterrows()
                    ],
                }
            )

        # Deterministic subset by unique image pair (no leakage: all of a
        # patch's annotations always stay together).
        if subset is not None and int(subset) < len(self.patches):
            rng = random.Random(self.seed)
            chosen = sorted(rng.sample(range(len(self.patches)), int(subset)))
            self.patches = [self.patches[i] for i in chosen]

        self._images_cache: dict[str, tuple[Image.Image, Image.Image]] = {}

    # -- helpers ------------------------------------------------------------

    @property
    def num_patches(self) -> int:
        return len(self.patches)

    @property
    def num_annotations(self) -> int:
        return sum(len(p["rows"]) for p in self.patches)

    def get_patch_images(self, patch_id: str) -> tuple[Image.Image, Image.Image]:
        """Return ``(s2_rgb, s1_rgb)`` for a patch, loading/caching on demand."""
        if patch_id in self._images_cache:
            return self._images_cache[patch_id]
        s1_bands, s2_bands = self.reader.read_pair(patch_id)
        s2_rgb = bands_to_rgb_s2(s2_bands)
        s1_rgb = bands_to_rgb_s1(s1_bands)
        self._images_cache[patch_id] = (s2_rgb, s1_rgb)
        return self._images_cache[patch_id]

    def materialize(self, patches: Iterable[dict]) -> list[dict]:
        """Turn a list of patch dicts into explicit training sample dicts.

        Every sample carries the two composites as the canonical top-level
        ``s2_rgb`` / ``s1_rgb`` PIL RGB image fields (the fields the trainer and
        the Qwen2-VL dataset read), plus ``images`` = ``(s2_rgb, s1_rgb)`` kept
        only for backward compatibility.
        """
        samples: list[dict] = []
        for p in patches:
            s2_rgb, s1_rgb = self.get_patch_images(p["patch_id"])
            for row in p["rows"]:
                samples.append(
                    {
                        "s2_rgb": s2_rgb,
                        "s1_rgb": s1_rgb,
                        "images": (s2_rgb, s1_rgb),
                        "question": row["input"].strip(),
                        "answer": row["output"].strip(),
                        "patch_id": p["patch_id"],
                        "type": row["type"],
                        "category": row["category"],
                        "split": row["split"],
                        "ID": row["ID"],
                    }
                )
        return samples


# ---------------------------------------------------------------------------
# Qwen2-VL SFT dataset (torch-backed; consumes materialized samples with the
# canonical top-level ``s2_rgb`` / ``s1_rgb`` fields above)
# ---------------------------------------------------------------------------


def _ensure_mm_token_type_ids(
    processor,
    processor_output: dict,
    input_ids,
):
    """Same safeguard as the RSVQA script: modality ids may need rebuilding."""
    if "mm_token_type_ids" in processor_output:
        return processor_output["mm_token_type_ids"].squeeze(0)

    create = getattr(processor, "create_mm_token_type_ids", None)
    if create is not None:
        ids = input_ids
        if hasattr(ids, "tolist"):
            ids = ids.tolist()
        result = create([ids])
        if result:
            return torch.tensor(result[0], dtype=torch.long)

    image_ids = set(getattr(processor, "image_token_id", None) or [])
    video_ids = set(getattr(processor, "video_token_id", None) or [])
    audio_ids = set(getattr(processor, "audio_token_id", None) or [])
    ids = input_ids
    if hasattr(ids, "tolist"):
        ids = ids.tolist()
    tids = make_mm_token_type_ids(
        ids, image_token_ids=image_ids, video_token_ids=video_ids,
        audio_token_ids=audio_ids,
    )
    return torch.tensor(tids, dtype=torch.long)


_QwenDatasetBase = torch.utils.data.Dataset if torch is not None else object


class BigEarthNetQwenDataset(_QwenDatasetBase):
    """Qwen2-VL SFT dataset for one two-image BigEarthNet training sample.

    Each item returns inputs dict with input_ids, attention_mask, pixel_values,
    image_grid_thw, and labels.  Labels are aligned to the FULL input sequence
    (prompt + answer) and only the assistant/answer tokens contribute to loss.
    """

    def __init__(self, samples: list[dict], processor, max_length: int) -> None:
        self.samples = samples
        self.processor = processor
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
        from qwen_vl_utils import process_vision_info

        s = self.samples[idx]
        question = str(s["question"]).strip()
        answer = str(s["answer"]).strip()

        if not question:
            raise ValueError(f"Sample {idx} has an empty question.")
        if not answer:
            raise ValueError(f"Sample {idx} has an empty answer.")

        # ---- Build the two-image conversation (S2 composite + S1 composite).
        user_msg, assistant_msg = build_qwen_conversation(
            s["s2_rgb"], s["s1_rgb"], question, answer
        )

        prompt_text = self.processor.apply_chat_template(
            [user_msg], tokenize=False, add_generation_prompt=True
        )
        full_text = self.processor.apply_chat_template(
            [user_msg, assistant_msg], tokenize=False, add_generation_prompt=False
        )
        image_inputs, video_inputs = process_vision_info([user_msg])
        if len(image_inputs) != 2:
            raise ValueError(
                f"Sample {idx}: expected exactly 2 images from process_vision_info, "
                f"got {len(image_inputs)}. The two-image conversation is malformed."
            )

        # ---- Encode WITHOUT truncation or padding (see RSVQA script notes).
        full_inputs = self.processor(
            text=[full_text],
            images=image_inputs,
            videos=video_inputs,
            return_tensors="pt",
            return_mm_token_type_ids=True,
        )
        input_ids = full_inputs["input_ids"].squeeze(0)
        attention_mask = full_inputs["attention_mask"].squeeze(0)
        pixel_values = full_inputs["pixel_values"].squeeze(0)
        image_grid_thw = full_inputs["image_grid_thw"].squeeze(0)
        mm_token_type_ids = _ensure_mm_token_type_ids(
            self.processor, full_inputs, input_ids
        )

        seq = input_ids.numel()
        if seq > self.max_length:
            raise ValueError(
                f"Sample {idx}: encoded sequence is {seq} tokens, which exceeds "
                f"--max-length {self.max_length}. The two image regions (+ answer) "
                f"must fit within max_length; increase --max-length."
            )

        prompt_inputs = self.processor(
            text=[prompt_text],
            images=image_inputs,
            videos=video_inputs,
            return_tensors="pt",
        )
        answer_start = prompt_inputs["input_ids"].shape[-1]

        labels = build_masked_labels(
            input_ids.tolist(),
            answer_start=answer_start,
            pad_token_id=self.processor.tokenizer.pad_token_id,
            max_length=self.max_length,
        )

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
            if mm_token_type_ids is not None:
                mm_token_type_ids = torch.tensor(
                    pad_token_type_ids(mm_token_type_ids.tolist(), self.max_length),
                    dtype=torch.long,
                )

        result = {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
            "pixel_values": pixel_values,
            "image_grid_thw": image_grid_thw,
            "labels": torch.tensor(labels, dtype=torch.long),
        }
        if mm_token_type_ids is not None:
            result["mm_token_type_ids"] = mm_token_type_ids
        return result


# ---------------------------------------------------------------------------
# Qwen2-VL conversation + no-leakage split (pure, testable helpers)
# ---------------------------------------------------------------------------


def build_qwen_conversation(
    s2_rgb: Image.Image,
    s1_rgb: Image.Image,
    question: str,
    answer: str,
) -> tuple[dict, dict]:
    """Build ``(user_msg, assistant_msg)`` for Qwen2-VL with two images.

    The user message carries the S2 false-color image, then the S1 composite
    image, then the instruction.  The assistant message carries the reference
    answer (also given for eval, where the answer is simply not consumed).
    """
    if s2_rgb.mode != "RGB":
        s2_rgb = s2_rgb.convert("RGB")
    if s1_rgb.mode != "RGB":
        s1_rgb = s1_rgb.convert("RGB")
    user_msg = {
        "role": "user",
        "content": [
            {"type": "image", "image": s2_rgb},
            {"type": "image", "image": s1_rgb},
            {"type": "text", "text": str(question)},
        ],
    }
    assistant_msg = {
        "role": "assistant",
        "content": [{"type": "text", "text": str(answer)}],
    }
    return user_msg, assistant_msg


def split_patches_no_leakage(
    patches: list[dict],
    holdout: int,
    seed: int = 42,
) -> tuple[list[dict], list[dict]]:
    """Split unique image pairs into ``(train_patches, eval_patches)``.

    Splitting at the *patch* level guarantees no annotation of a patch can
    appear in both train and eval (no data leakage).  ``holdout`` is capped to
    ``len(patches) - 1`` so at least one training patch remains.
    """
    total = len(patches)
    if total <= 1:
        return list(patches), []
    n_eval = min(int(holdout), total - 1)
    rng = random.Random(seed)
    eval_idx = set(rng.sample(range(total), n_eval))
    train = [patches[i] for i in range(total) if i not in eval_idx]
    evalp = [patches[i] for i in sorted(eval_idx)]
    return train, evalp


def select_eval_samples(samples: list[dict], n: int, seed: int) -> list[dict]:
    """Deterministically choose a stable eval sample list for a given seed."""
    if n <= 0:
        return []
    rng = random.Random(seed)
    if n >= len(samples):
        return list(samples)
    idx = sorted(rng.sample(range(len(samples)), n))
    return [samples[i] for i in idx]


def validate_samples(samples: list[dict]) -> None:
    """Ensure every materialized sample has the required two-image fields."""
    for i, s in enumerate(samples):
        for field in ("s2_rgb", "s1_rgb", "question", "answer"):
            if field not in s or s[field] in (None, ""):
                raise ValueError(
                    f"Dataset sample {i} is missing required field '{field}'. "
                    f"Expected BigEarthNet fields: s2_rgb, s1_rgb, question, answer. "
                    f"Sample keys: {sorted(s.keys())}"
                )
        for key, img in (("s2_rgb", s["s2_rgb"]), ("s1_rgb", s["s1_rgb"])):
            if not isinstance(img, Image.Image):
                raise TypeError(
                    f"Dataset sample {i}: '{key}' must be a PIL.Image, got "
                    f"{type(img).__name__}"
                )
            if img.mode != "RGB":
                # Normalize eagerly so the dataset never sees a palette/gray image.
                s[key] = img.convert("RGB")


def collate_bigearthnet_batch(batch: list[dict]) -> dict:
    """Collate a DataLoader batch of BigEarthNet Qwen2-VL training samples.

    Text tensors (``input_ids``, ``attention_mask``, ``labels``,
    ``mm_token_type_ids``) are right-padded to a fixed ``max_length`` by the
    dataset, so they stack on the batch dim.  Vision tensors are
    variable-length per sample (``pixel_values`` is ``(num_image_tokens,
    hidden_dim)`` and ``image_grid_thw`` is ``(num_images, 3)``); the default
    stack would add a spurious leading batch dim that Qwen2-VL rejects with
    ``ValueError: not enough values to unpack (expected 3, got 2)``.  They are
    concatenated along dim 0 to ``(total_image_tokens, hidden_dim)`` and
    ``(total_images, 3)`` respectively, matching what the model's forward pass
    expects.
    """
    import torch

    out: dict = {}
    for key in batch[0]:
        tensors = [sample[key] for sample in batch]
        if key in ("pixel_values", "image_grid_thw"):
            out[key] = torch.cat(tensors, dim=0)
        else:
            out[key] = torch.stack(tensors, dim=0)
    return out


# ---------------------------------------------------------------------------
# Preflight (pre-training sanity checks; also exposed as a CLI)
# ---------------------------------------------------------------------------


def run_preflight(
    parquet_path: str | Path,
    lmdb_dir: str | Path,
    *,
    types: Iterable[str] = ("binary", "mcq"),
    max_patches: int = 1,
    img_size: int = 120,
) -> dict:
    """Run every pre-training check required before a real training pass.

    Verifies, in order:
      1. parquet exists and has the official columns (+ rows after filtering)
      2. LMDB directory exists, contains data.mdb, opens, and is non-empty
      3. at least one train annotation exists for the requested types
      4. at least one matching S1/S2 pair can be read from the LMDB
      5. both sensors expose the expected composite bands
      6. band conversion to two PIL RGB images succeeds
      7. the resulting Qwen2-VL conversation structure is well-formed

    This DOES NOT attempt to fall back to metadata-only or synthetic imagery.
    On any required failure it raises ``PreflightError`` with an actionable
    message.  ``max_patches`` input pairs are validated.

    Returns a ``report`` dict with per-check details (callers may also want
    the successfully converted sample for a processor-level check).
    """
    checks: list[dict] = []
    report: dict = {
        "preflight": "bigearthnet",
        "ok": False,
        "parquet_path": str(parquet_path),
        "lmdb_dir": str(lmdb_dir),
        "types": list(types),
        "max_patches": int(max_patches),
        "checks": checks,
    }

    def _check(name: str, ok: bool, detail: str) -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    failures: list[str] = []

    # 1. parquet
    pf = Path(parquet_path)
    if not pf.exists():
        _check("parquet_exists", False, "MISSING")
        failures.append(f"parquet not found: {pf}")
    else:
        try:
            import pandas as pd

            df = pd.read_parquet(pf)
            missing = REQUIRED_PARQUET_COLUMNS - set(df.columns)
            if missing:
                _check("parquet_columns", False, f"missing {sorted(missing)}")
                failures.append(f"parquet missing columns {sorted(missing)}")
            else:
                filtered = df[df["type"].isin(types)]
                n = int(len(filtered))
                _check("parquet_columns", True, f"all {len(REQUIRED_PARQUET_COLUMNS)} columns present")
                _check(
                    "parquet_annotations",
                    n > 0,
                    f"{n} annotations for types {list(types)}",
                )
                if n == 0:
                    failures.append(f"no annotations for types {list(types)}")
        except Exception as exc:
            _check("parquet_readable", False, repr(exc))
            failures.append(f"parquet read failed: {exc!r}")

    # 2. LMDB availability
    lm = Path(lmdb_dir)
    try:
        reader = BENImageReader(lm, pf)  # loads parquet mapping
        reader.open_env()
        entries = reader.env.stat()["entries"] if reader.env else 0
        _check("lmdb_exists", True, f"opened {lm}, {entries} entries")
    except BigEarthNetError as exc:
        _check("lmdb_exists", False, str(exc).splitlines()[0])
        failures.append(str(exc))
        report["ok"] = False
        if failures:
            raise PreflightError(_format_preflight_failure(failures, checks))
        return report

    # 3-7. sample patches
    try:
        ds = BigEarthNetDataset(
            pf, lm, types=types, splits=("train",), subset=max_patches, seed=0
        )
        if ds.num_patches == 0:
            _check("matching_pair", False, "no train patches for the requested types")
            failures.append("no train patches for the requested types")
        else:
            s1_bands, s2_bands = ds.reader.read_pair(ds.patches[0]["patch_id"])
            band_ok = S2_COMPOSITE_BANDS.issubset(s2_bands) and S1_COMPOSITE_BANDS.issubset(s1_bands)
            _check(
                "sensor_bands",
                band_ok,
                f"S2 has {sorted(s2_bands)}; S1 has {sorted(s1_bands)}",
            )
            if not band_ok:
                failures.append(
                    "expected composite bands missing (S2: "
                    f"{sorted(S2_COMPOSITE_BANDS)}; S1: {sorted(S1_COMPOSITE_BANDS)})"
                )
            sample = ds.materialize(ds.patches[:max_patches])[0]
            s2_rgb = sample["s2_rgb"]
            s1_rgb = sample["s1_rgb"]
            _check(
                "matching_pair",
                True,
                f"{ds.num_patches} train patches; first sample: "
                f"patch={sample['patch_id']} type={sample['type']}",
            )
            imgs_ok = (
                isinstance(s2_rgb, Image.Image)
                and isinstance(s1_rgb, Image.Image)
                and s2_rgb.mode == "RGB"
                and s1_rgb.mode == "RGB"
                and s2_rgb.size[0] > 0
                and s1_rgb.size[0] > 0
            )
            _check("rgb_conversion", imgs_ok, f"S2 {s2_rgb.size} {s2_rgb.mode}; S1 {s1_rgb.size} {s1_rgb.mode}")
            if not imgs_ok:
                failures.append("RGB conversion did not produce RGB PIL images")
            user_msg, assistant_msg = build_qwen_conversation(
                s2_rgb, s1_rgb, sample["question"], sample["answer"]
            )
            conv_ok = (
                user_msg["role"] == "user"
                and len(user_msg["content"]) == 3
                and [c["type"] for c in user_msg["content"]] == ["image", "image", "text"]
                and assistant_msg["role"] == "assistant"
                and assistant_msg["content"][0]["type"] == "text"
            )
            _check(
                "conversation_shape",
                conv_ok,
                "user=[image, image, text] assistant=[text]",
            )
            if not conv_ok:
                failures.append("conversation structure malformed")

            report["sample"] = {
                "patch_id": sample["patch_id"],
                "type": sample["type"],
                "category": sample["category"],
                "question": sample["question"][:200],
                "answer": sample["answer"][:200],
                "s2_image_size": s2_rgb.size,
                "s1_image_size": s1_rgb.size,
            }
    except BigEarthNetError as exc:
        _check("sample_read", False, str(exc).splitlines()[0])
        failures.append(str(exc))

    report["ok"] = not failures
    if failures:
        raise PreflightError(_format_preflight_failure(failures, checks))
    return report


def _format_preflight_failure(failures: list[str], checks: list[dict]) -> str:
    """Build a readable, actionable PreflightError message."""
    lines = [
        "BigEarthNet.txt preflight FAILED — training cannot start. "
        "No metadata-only or synthetic fallback exists.",
    ]
    for f in failures:
        lines.append(f"- {f}")
    failed_checks = [c["name"] for c in checks if not c["ok"]]
    if failed_checks:
        lines.append(f"Failed checks: {failed_checks}")
    if any("LMDB imagery" in f or "Encoded-BigEarthNet" in f for f in failures):
        lines.append(
            "Action: place the official Encoded-BigEarthNet LMDB on disk and "
            "point --lmdb at it (Kaggle: accept the 'BigEarthNet v2.0 "
            "Encoded-BigEarthNet' dataset volume; or run rico-hdl to build the "
            "LMDB from downloaded S1/S2 GeoTIFFs)."
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI entrypoint (standalone, lightweight: no torch/transformers needed)
# ---------------------------------------------------------------------------


def _cli() -> int:
    parser = argparse.ArgumentParser(
        description="BigEarthNet.txt datasets + preflight (lightweight)."
    )
    parser.add_argument("--parquet", required=True, help="Path to BigEarthNet.txt.parquet")
    parser.add_argument("--lmdb", required=True, help="Path to Encoded-BigEarthNet LMDB dir")
    parser.add_argument("--types", default="binary,mcq", help="Comma-separated annotation types")
    parser.add_argument("--max-patches", type=int, default=1, help="Pairs to validate (default 1)")
    parser.add_argument("--preflight", action="store_true", help="Run the preflight checks and exit")
    parser.add_argument("--json", action="store_true", help="Emit the preflight report as JSON")
    args = parser.parse_args()

    types = [t.strip() for t in args.types.split(",") if t.strip()]
    if args.preflight:
        try:
            report = run_preflight(
                args.parquet, args.lmdb, types=types, max_patches=args.max_patches
            )
        except BigEarthNetError as exc:
            print(f"[preflight] FAILED:\n{exc}", file=sys.stderr)
            return 2
        if args.json:
            print(json.dumps(report, indent=2, default=str))
        else:
            print("[preflight] OK")
            for c in report["checks"]:
                print(f"  [{'OK' if c['ok'] else 'FAIL'}] {c['name']}: {c['detail']}")
        return 0
    parser.error("Provide --preflight (see --help).")
    return 2


if __name__ == "__main__":
    sys.exit(_cli())