"""Focused unit tests for the BigEarthNet.txt adaptation dataset module.

These tests are dependency-light by design: they never open the official LMDB
(missing locally and on CI) and never load torch/transformers.  Compose paths
use small synthetic band arrays and the error paths are exercised with temp
parquet files plus nonexistent LMDB directories.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from PIL import Image

from adaptation.bigearthnet_dataset import (
    BENImageReader,
    BandNotFoundError,
    BigEarthNetDataError,
    BigEarthNetDataset,
    ImageryNotAvailableError,
    PreflightError,
    S2_COMPOSITE_BANDS,
    S1_COMPOSITE_BANDS,
    bands_to_rgb_s1,
    bands_to_rgb_s2,
    build_qwen_conversation,
    percentile_normalize,
    run_preflight,
    split_patches_no_leakage,
    validate_samples,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_bands(**kwargs) -> dict[str, np.ndarray]:
    """Build a minimal band dict; every channel 120x120 by default."""
    size = kwargs.pop("size", 120)
    defaults = {
        "VV": np.linspace(0.0, 100.0, size * size).reshape(size, size),
        "VH": np.linspace(10.0, 60.0, size * size).reshape(size, size),
        "B02": np.linspace(0.0, 200.0, size * size).reshape(size, size),
        "B03": np.linspace(0.0, 100.0, size * size).reshape(size, size),
        "B04": np.linspace(0.0, 150.0, size * size).reshape(size, size),
        "B05": np.linspace(0.0, 120.0, size * size).reshape(size, size),
        "B06": np.linspace(0.0, 110.0, size * size).reshape(size, size),
        "B07": np.linspace(0.0, 100.0, size * size).reshape(size, size),
        "B08": np.linspace(0.0, 250.0, size * size).reshape(size, size),
        "B8A": np.linspace(0.0, 140.0, size * size).reshape(size, size),
        "B11": np.linspace(0.0, 130.0, size * size).reshape(size, size),
        "B12": np.linspace(0.0, 90.0, size * size).reshape(size, size),
    }
    defaults.update(kwargs)
    return defaults


def _bigearthnet_parquet(tmp_path: Path) -> Path:
    """Write a small BigEarthNet.txt-style parquet with a repeated patch."""
    rows = []
    patch_specs = [
        ("PATCH_A", "S1_A", "train", "binary", "land-cover", "polar_night",
         "snow", "56.0", "12.0", "Sweden", "boreal"),
        ("PATCH_A", "S1_A", "train", "mcq", "land-cover", "polar_night",
         "snow", "56.0", "12.0", "Sweden", "boreal"),
        ("PATCH_B", "S1_B", "train", "mcq", "climate", "mid-latitude",
         "spring", "40.7", "-74.0", "USA", "continental"),
        ("PATCH_C", "S1_C", "validation", "binary", "land-cover", "mid-latitude",
         "autumn", "48.8", "2.3", "France", "temperate"),
        ("PATCH_D", "S1_D", "train", "captioning", "land-cover", "mid-latitude",
         "winter", "41.9", "12.5", "Italy", "mediterranean"),
        ("PATCH_B", "S1_B", "bench", "binary", "climate", "mid-latitude",
         "spring", "40.7", "-74.0", "USA", "continental"),
    ]
    for i, (pid, s1, split, typ, cat, c_zone, season, lat, lon, country, climate) in enumerate(patch_specs):
        rows.append(
            {
                "ID": f"BEN0000000{i}",
                "patch_id": pid,
                "s1_name": s1,
                "input": f"Question about {pid}?",
                "output": "yes" if i % 2 == 0 else "A^yellow",
                "type": typ,
                "category": cat,
                "split": split,
                "latitude": lat,
                "longitude": lon,
                "country": country,
                "season": season,
                "climate_zone": c_zone,
            }
        )
    pf = tmp_path / "BigEarthNet.txt.parquet"
    pd.DataFrame(rows).to_parquet(pf, index=False)
    return pf


# ---------------------------------------------------------------------------
# percentile_normalize
# ---------------------------------------------------------------------------


def test_percentile_normalize_linear_stretch():
    arr = np.array([[0.0, 10.0], [20.0, 30.0]])
    out = percentile_normalize(arr, low=0.0, high=100.0)
    assert out.shape == arr.shape
    assert np.allclose(out, arr / 30.0)


def test_percentile_normalize_constant_channel_is_mid_gray():
    arr = np.full((4, 4), 42.0)
    out = percentile_normalize(arr)
    assert np.allclose(out, 0.5)


def test_percentile_normalize_nonfinite_become_mid_gray():
    arr = np.array([[1.0, np.nan], [np.inf, 5.0]])
    out = percentile_normalize(arr)
    assert np.all(np.isfinite(out))
    assert out[0, 1] == 0.5
    assert out[1, 0] == 0.5


def test_percentile_normalize_rejects_1d():
    with pytest.raises(ValueError):
        percentile_normalize(np.array([1.0, 2.0]))


def test_percentile_normalize_all_nan_is_mid_gray():
    arr = np.full((3, 3), np.nan)
    assert np.allclose(percentile_normalize(arr), 0.5)


# ---------------------------------------------------------------------------
# Composite functions
# ---------------------------------------------------------------------------


def test_bands_to_rgb_s2_mapping_and_shape():
    img = bands_to_rgb_s2(_make_bands())
    assert isinstance(img, Image.Image)
    assert img.mode == "RGB"
    assert img.size == (120, 120)
    arr = np.asarray(img, dtype=np.float32) / 255.0
    s2 = _make_bands()
    assert np.allclose(arr[..., 0], percentile_normalize(s2["B08"]), atol=2 / 255)
    assert np.allclose(arr[..., 1], percentile_normalize(s2["B04"]), atol=2 / 255)
    assert np.allclose(arr[..., 2], percentile_normalize(s2["B03"]), atol=2 / 255)


def test_bands_to_rgb_s2_missing_band_raises():
    bands = _make_bands()
    del bands["B08"]
    with pytest.raises(BandNotFoundError):
        bands_to_rgb_s2(bands)


def test_bands_to_rgb_s1_missing_band_raises():
    bands = _make_bands()
    del bands["VV"]
    with pytest.raises(BandNotFoundError):
        bands_to_rgb_s1(bands)


def test_bands_to_rgb_s1_mapping_and_shape():
    img = bands_to_rgb_s1(_make_bands())
    assert isinstance(img, Image.Image)
    assert img.mode == "RGB"
    assert img.size == (120, 120)
    arr = np.asarray(img, dtype=np.float32) / 255.0
    bands = _make_bands()
    vv = bands["VV"]
    vh = bands["VH"]
    ratio = vv / vh
    assert np.allclose(arr[..., 0], percentile_normalize(vv), atol=2 / 255)
    assert np.allclose(arr[..., 1], percentile_normalize(vh), atol=2 / 255)
    assert np.allclose(arr[..., 2], percentile_normalize(ratio), atol=2 / 255)


def test_bands_to_rgb_s1_mismatched_shapes_raises():
    bands = _make_bands()
    bands["VH"] = np.zeros((10, 10))
    with pytest.raises(Exception):
        bands_to_rgb_s1(bands)


def test_bands_to_rgb_s1_zero_division_safe():
    bands = _make_bands()
    bands["VH"] = np.zeros((120, 120))
    img = bands_to_rgb_s1(bands)
    assert np.all(np.isfinite(np.asarray(img, dtype=np.float32)))


# ---------------------------------------------------------------------------
# build_qwen_conversation
# ---------------------------------------------------------------------------


def test_build_qwen_conversation_structure():
    s2 = bands_to_rgb_s2(_make_bands())
    s1 = bands_to_rgb_s1(_make_bands())
    user_msg, assistant_msg = build_qwen_conversation(s2, s1, "Q?", "yes")
    assert user_msg["role"] == "user"
    assert [c["type"] for c in user_msg["content"]] == ["image", "image", "text"]
    assert user_msg["content"][2]["text"] == "Q?"
    assert assistant_msg["role"] == "assistant"
    assert assistant_msg["content"][0]["text"] == "yes"


def test_build_qwen_conversation_coerces_to_rgb():
    gray = Image.new("L", (8, 8))
    user_msg, _ = build_qwen_conversation(gray, gray, "Q?", "no")
    imgs = [c["image"] for c in user_msg["content"] if c["type"] == "image"]
    assert all(im.mode == "RGB" for im in imgs)


# ---------------------------------------------------------------------------
# split_patches_no_leakage
# ---------------------------------------------------------------------------


def test_split_no_leakage_disjoint_and_complete():
    patches = [{"patch_id": f"p{i}"} for i in range(20)]
    train, evalp = split_patches_no_leakage(patches, holdout=5, seed=1)
    train_ids = {p["patch_id"] for p in train}
    eval_ids = [p["patch_id"] for p in evalp]
    assert len(eval_ids) == 5
    assert train_ids.isdisjoint(eval_ids)
    assert set(train_ids) | set(eval_ids) == {f"p{i}" for i in range(20)}
    assert len(set(eval_ids)) == 5


def test_split_no_leakage_caps_holdout():
    patches = [{"patch_id": f"p{i}"} for i in range(3)]
    train, evalp = split_patches_no_leakage(patches, holdout=99)
    assert len(evalp) == 2
    assert len(train) == 1


def test_split_no_leakage_single_patch():
    patches = [{"patch_id": "solo"}]
    train, evalp = split_patches_no_leakage(patches, holdout=1)
    assert train == patches
    assert evalp == []


# ---------------------------------------------------------------------------
# BigEarthNetDataset (no LMDB open at construction; pyarrow-backed parquet)
# ---------------------------------------------------------------------------


def test_dataset_groups_annotations_by_patch(tmp_path):
    pf = _bigearthnet_parquet(tmp_path)
    # Every supported-type row across all splits, to verify grouping (not
    # filtering): PATCH_A x2, PATCH_B mcq + bench-binary, PATCH_C val binary.
    ds = BigEarthNetDataset(
        pf, tmp_path / "nope_lmdb",
        types=("binary", "mcq"),
        splits=("train", "validation", "bench"),
    )
    assert isinstance(ds.patches, list)
    assert ds.num_patches == 3
    assert ds.num_annotations == 5
    by_id = {p["patch_id"]: p for p in ds.patches}
    assert len(by_id["PATCH_A"]["rows"]) == 2  # both annotations share one patch


def test_dataset_filters_by_type(tmp_path):
    pf = _bigearthnet_parquet(tmp_path)
    # Widen splits so only the type filter is being exercised.
    ds = BigEarthNetDataset(
        pf, tmp_path / "nope_lmdb",
        types=("binary",),
        splits=("train", "validation", "bench"),
    )
    assert all(r["type"] == "binary" for p in ds.patches for r in p["rows"])
    assert ds.num_patches == 3  # PATCH_A, PATCH_C, PATCH_B(bench row)


def test_dataset_filters_by_split(tmp_path):
    pf = _bigearthnet_parquet(tmp_path)
    ds = BigEarthNetDataset(pf, tmp_path / "nope_lmdb", splits=("validation",))
    assert ds.num_patches == 1
    assert ds.patches[0]["patch_id"] == "PATCH_C"


def test_dataset_subset_caps_unique_patches(tmp_path):
    pf = _bigearthnet_parquet(tmp_path)
    ds = BigEarthNetDataset(pf, tmp_path / "nope_lmdb", subset=2, seed=42)
    assert ds.num_patches == 2


def test_materialize_exposes_canonical_s2_rgb_s1_rgb(tmp_path, monkeypatch):
    """materialize() must expose top-level s2_rgb / s1_rgb PIL RGB images.

    Regression guard for the runtime error
    ``ValueError: Dataset sample 0 is missing required field 's2_rgb'.`` —
    the trainer reads the canonical top-level fields, so they must exist on
    every materialized sample.
    """
    pf = _bigearthnet_parquet(tmp_path)
    ds = BigEarthNetDataset(pf, tmp_path / "nope_lmdb", splits=("train",))
    s2 = Image.new("RGB", (16, 12))
    s1 = Image.new("RGB", (16, 12))
    monkeypatch.setattr(ds, "get_patch_images", lambda patch_id: (s2, s1))

    samples = ds.materialize(ds.patches)
    assert samples
    for s in samples:
        assert s["s2_rgb"] is s2
        assert s["s1_rgb"] is s1
        assert isinstance(s["s2_rgb"], Image.Image) and s["s2_rgb"].mode == "RGB"
        assert isinstance(s["s1_rgb"], Image.Image) and s["s1_rgb"].mode == "RGB"
        # Backward-compatible tuple kept alongside the canonical fields.
        assert s["images"] == (s2, s1)
        # The observed runtime key set plus the two canonical image fields.
        assert set(s) == {
            "ID", "answer", "category", "images", "patch_id", "question",
            "split", "type", "s2_rgb", "s1_rgb",
        }
        assert s["question"] and s["answer"] and s["patch_id"]


def _materialized_sample(s2_mode="RGB", s1_mode="RGB") -> dict:
    return {
        "s2_rgb": Image.new(s2_mode, (8, 8)),
        "s1_rgb": Image.new(s1_mode, (8, 8)),
        "images": (Image.new(s2_mode, (8, 8)), Image.new(s1_mode, (8, 8))),
        "question": "Is the land cover agricultural?",
        "answer": "yes",
        "patch_id": "PATCH_A",
        "type": "binary",
        "category": "land-cover",
        "split": "train",
        "ID": "BEN00000000",
    }


def test_validate_samples_accepts_materialized_sample():
    """validate_samples must accept a materialized sample unchanged (no raise)."""
    sample = _materialized_sample()
    validate_samples([sample])


def test_validate_samples_normalizes_non_rgb_images():
    """Palette/gray images are eagerly converted to RGB, never rejected."""
    sample = _materialized_sample(s2_mode="L", s1_mode="P")
    validate_samples([sample])
    assert sample["s2_rgb"].mode == "RGB"
    assert sample["s1_rgb"].mode == "RGB"


def test_validate_samples_missing_s2_rgb_raises():
    """A sample lacking the canonical s2_rgb field fails loudly."""
    sample = _materialized_sample()
    del sample["s2_rgb"]
    with pytest.raises(ValueError, match="missing required field 's2_rgb'"):
        validate_samples([sample])


def test_validate_samples_rejects_non_pil_image():
    sample = _materialized_sample()
    sample["s1_rgb"] = "not an image"
    with pytest.raises(TypeError, match="'s1_rgb' must be a PIL.Image"):
        validate_samples([sample])


def test_dataset_missing_parquet_raises(tmp_path):
    with pytest.raises(BigEarthNetDataError):
        BigEarthNetDataset(tmp_path / "does_not_exist.parquet", tmp_path / "nope")


def test_dataset_unsupported_type_raises(tmp_path):
    pf = _bigearthnet_parquet(tmp_path)
    with pytest.raises(BigEarthNetDataError):
        BigEarthNetDataset(pf, tmp_path / "nope_lmdb", types=("bbox",))


def test_dataset_unsupported_split_raises(tmp_path):
    pf = _bigearthnet_parquet(tmp_path)
    with pytest.raises(BigEarthNetDataError):
        BigEarthNetDataset(pf, tmp_path / "nope_lmdb", splits=("bogus",))


# ---------------------------------------------------------------------------
# BENImageReader error paths (no lmdb locally → exercise clear failures)
# ---------------------------------------------------------------------------


def test_reader_open_env_missing_lmdb(tmp_path):
    pf = _bigearthnet_parquet(tmp_path)
    reader = BENImageReader(tmp_path / "missing_lmdb", pf)
    with pytest.raises(ImageryNotAvailableError):
        reader.open_env()


def test_reader_read_pair_fails_cleanly_without_lmdb(tmp_path):
    pf = _bigearthnet_parquet(tmp_path)
    reader = BENImageReader(tmp_path / "missing_lmdb", pf)
    assert reader.mapping is not None
    assert reader.mapping["PATCH_A"] == "S1_A"
    with pytest.raises(ImageryNotAvailableError):
        reader.read_pair("PATCH_A")


# ---------------------------------------------------------------------------
# run_preflight
# ---------------------------------------------------------------------------


def test_run_preflight_missing_parquet(tmp_path):
    with pytest.raises(PreflightError):
        run_preflight(
            tmp_path / "no.parquet",
            tmp_path / "missing_lmdb",
        )


def test_run_preflight_missing_lmdb(tmp_path):
    pf = _bigearthnet_parquet(tmp_path)
    with pytest.raises(PreflightError) as einfo:
        run_preflight(pf, tmp_path / "missing_lmdb", max_patches=1)
    msg = str(einfo.value)
    assert "preflight FAILED" in msg
    assert "Encoded-BigEarthNet" in msg
    assert "metadata-only or synthetic fallback" in msg


def test_run_preflight_reports_lmdb_check_failed(tmp_path):
    pf = _bigearthnet_parquet(tmp_path)
    try:
        run_preflight(pf, tmp_path / "missing_lmdb", max_patches=1)
    except PreflightError as exc:
        assert "lmdb_exists" in str(exc)
    else:
        pytest.fail("expected PreflightError")


# ---------------------------------------------------------------------------
# Constants sanity
# ---------------------------------------------------------------------------


def test_composite_band_requirements_match_official_combination():
    assert S2_COMPOSITE_BANDS == {"B08", "B04", "B03"}
    assert S1_COMPOSITE_BANDS == {"VV", "VH"}