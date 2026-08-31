"""Tests for band detection."""

from __future__ import annotations

from app.preprocessing.band_detection import (
    detect_bands,
    detect_modality_from_bands,
)


def test_known_band_metadata():
    result = detect_bands(
        band_descriptions=["red", "green", "blue", "nir"],
        band_count=4,
    )
    assert result.detection_method == "band_descriptions"
    assert result.has_required_optical_bands is True
    assert result.unknown_band_count == 0
    names = [b.detected_name for b in result.bands]
    assert "red" in names
    assert "nir" in names


def test_empty_metadata_unknown():
    result = detect_bands(
        band_descriptions=["", "", ""],
        band_count=3,
    )
    assert result.detection_method == "none"
    assert result.unknown_band_count == 3
    assert result.has_required_optical_bands is False
    assert len(result.warnings) > 0


def test_sar_detection():
    result = detect_bands(
        band_descriptions=["VV", "VH"],
        band_count=2,
    )
    assert result.has_required_sar_bands is True


def test_no_band_metadata_at_all():
    result = detect_bands(
        band_descriptions=[],
        band_count=4,
    )
    assert result.detection_method == "none"


def test_unknown_band_names():
    result = detect_bands(
        band_descriptions=["channel_a", "channel_b"],
        band_count=2,
    )
    assert result.unknown_band_count == 2
    assert all(not b.is_known for b in result.bands)


def test_partial_known_bands():
    result = detect_bands(
        band_descriptions=["red", "unknown_band"],
        band_count=2,
    )
    assert result.unknown_band_count == 1
    assert result.has_required_optical_bands is False  # no nir


def test_detect_modality_optical():
    assert detect_modality_from_bands(["red", "green", "blue", "nir"], 4) == "optical"


def test_detect_modality_sar():
    assert detect_modality_from_bands(["VV", "VH"], 2) == "sar"


def test_detect_modality_unknown():
    assert detect_modality_from_bands(["", ""], 2) == "unknown"


def test_detect_modality_sar_keyword():
    assert detect_modality_from_bands(["sigma0", "sigma_nought"], 2) == "sar"
