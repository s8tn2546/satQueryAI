"""Tests for the /fetch-imagery acquisition core (app/tools/fetch_imagery.py)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.gee_client import (
    GeeAuthError,
    GeeQueryError,
    MockGeeProvider,
    RealGeeProvider,
)
from app.tools.fetch_imagery import (
    FetchNoImageError,
    FetchValidationError,
    fetch_confidence,
    fetch_imagery,
    fetch_status,
    parse_date_window,
    validate_bbox,
)

REGION = {
    "type": "Polygon",
    "coordinates": [[[78.0, 28.0], [78.5, 28.0], [78.5, 28.5], [78.0, 28.5], [78.0, 28.0]]],
}


# --------------------------------------------------------------------------- #
# Bounding-box validation                                                      #
# --------------------------------------------------------------------------- #


def test_validate_bbox_valid():
    meta = validate_bbox(REGION)
    assert meta["type"] == "Polygon"
    assert meta["area_deg2"] > 0
    assert meta["bounds"]["west"] == 78.0


def test_validate_bbox_invalid_geometry():
    with pytest.raises(FetchValidationError):
        validate_bbox({"type": "Point", "coordinates": [0, 0]})


def test_validate_bbox_malformed():
    with pytest.raises(FetchValidationError):
        validate_bbox({"type": "Polygon", "coordinates": "nonsense"})


def test_validate_bbox_zero_area():
    zero = {
        "type": "Polygon",
        "coordinates": [[[78.0, 28.0], [78.0, 28.0], [78.0, 28.0], [78.0, 28.0], [78.0, 28.0]]],
    }
    with pytest.raises(FetchValidationError):
        validate_bbox(zero)


def test_validate_bbox_invalid_longitude():
    bad = {
        "type": "Polygon",
        "coordinates": [[[200.0, 28.0], [201.0, 28.0], [201.0, 29.0], [200.0, 29.0], [200.0, 28.0]]],
    }
    with pytest.raises(FetchValidationError):
        validate_bbox(bad)


def test_validate_bbox_invalid_latitude():
    bad = {
        "type": "Polygon",
        "coordinates": [[[78.0, 100.0], [78.5, 100.0], [78.5, 100.5], [78.0, 100.5], [78.0, 100.0]]],
    }
    with pytest.raises(FetchValidationError):
        validate_bbox(bad)


def test_validate_bbox_multipolygon_supported():
    region = {
        "type": "MultiPolygon",
        "coordinates": [
            [[[78.0, 28.0], [78.1, 28.0], [78.1, 28.1], [78.0, 28.1], [78.0, 28.0]]],
            [[[79.0, 28.0], [79.1, 28.0], [79.1, 28.1], [79.0, 28.1], [79.0, 28.0]]],
        ],
    }
    meta = validate_bbox(region)
    assert meta["type"] == "MultiPolygon"


# --------------------------------------------------------------------------- #
# Date-window validation                                                       #
# --------------------------------------------------------------------------- #


def test_parse_date_window_defaults():
    start, end, pref, warnings = parse_date_window(None, None)
    assert start < end
    assert pref is None
    assert warnings == []


def test_parse_date_window_invalid_date():
    with pytest.raises(FetchValidationError):
        parse_date_window("not-a-date", None)


def test_parse_date_window_start_ge_end():
    with pytest.raises(FetchValidationError):
        parse_date_window("2022-01-01", "2021-01-01")
    with pytest.raises(FetchValidationError):
        parse_date_window("2021-01-01", "2021-01-01")


def test_parse_date_window_future_date():
    with pytest.raises(FetchValidationError):
        parse_date_window("2020-01-01", "2099-01-01")


def test_parse_date_window_preferred_outside_hints():
    start, end, pref, warnings = parse_date_window(
        "2021-01-01", "2021-06-01", preferred_date="2022-01-01"
    )
    assert pref == "2022-01-01"
    assert any("outside the search window" in w for w in warnings)


def test_parse_date_window_only_start():
    start, end, pref, warnings = parse_date_window("2021-01-01", None)
    assert start == "2021-01-01"
    assert end > start


# --------------------------------------------------------------------------- #
# Mock provider behaviour                                                      #
# --------------------------------------------------------------------------- #


def test_mock_provider_deterministic():
    m1 = MockGeeProvider()
    m2 = MockGeeProvider()
    a = m1.fetch_pair(REGION, "2021-01-01", "2021-06-01")
    b = m2.fetch_pair(REGION, "2021-01-01", "2021-06-01")
    assert a == b


def test_mock_provider_explicitly_labelled():
    p = MockGeeProvider()
    payload = p.fetch_pair(REGION, "2021-01-01", "2021-06-01")
    assert payload["source"] == "mock"
    # Mock never produces real files or claims to have downloaded imagery.
    assert payload["optical"]["file_path"] is None
    assert payload["optical"]["downloaded"] is False
    assert payload["sar"]["file_path"] is None
    assert payload["sar"]["downloaded"] is False
    assert any("Mock/fixture" in w for w in payload["provider_warnings"])


def test_mock_provider_metadata_shape():
    payload = MockGeeProvider().fetch_pair(REGION, "2021-01-01", "2021-06-01", "2021-03-01")
    opt = payload["optical"]
    sar = payload["sar"]
    assert opt["modality"] == "optical" and opt["source"] == "sentinel-2"
    assert sar["modality"] == "sar" and sar["source"] == "sentinel-1"
    assert "polarization" in sar and "orbit" in sar


# --------------------------------------------------------------------------- #
# Real provider fails clearly, never fabricates                                #
# --------------------------------------------------------------------------- #


def test_real_provider_no_creds_fails_clearly(monkeypatch):
    # Ensure no GEE_* env and no persisted creds so RealGeeProvider cannot auth.
    for k in ("GEE_PROJECT_ID", "GEE_SERVICE_ACCOUNT", "GEE_SERVICE_ACCOUNT_KEY_PATH"):
        monkeypatch.delenv(k, raising=False)
    provider = RealGeeProvider(credentials={})
    # The credentials dict is explicitly empty and ee default auth also fails
    # without a persisted login in CI — it must raise, not fabricate.
    with pytest.raises((GeeAuthError, GeeQueryError)):
        provider.fetch_pair(REGION, "2021-01-01", "2021-06-01")


# --------------------------------------------------------------------------- #
# Orchestrator + validation-pipeline integration                               #
# --------------------------------------------------------------------------- #


class _GeeFakeProvider:
    """A fake 'real' provider that returns local GeoTIFF files (no network)."""

    def __init__(self, optical_path=None, sar_path=None, *, source="gee",
                 date_gap=2, warnings=None):
        self._optical = optical_path
        self._sar = sar_path
        self._source = source
        self._date_gap = date_gap
        self._warnings = warnings or []

    def fetch_pair(self, region, start, end, preferred_date=None):
        payload = {
            "source": self._source,
            "date_gap_days": self._date_gap,
            "provider_warnings": list(self._warnings),
        }
        if self._optical is not None:
            payload["optical"] = {
                "modality": "optical",
                "source": "sentinel-2",
                "satellite": "Sentinel-2",
                "collection": "COPERNICUS/S2_SR_HARMONIZED",
                "file_path": str(self._optical),
                "downloaded": True,
                "capture_date": "2021-03-01T00:00:00Z",
                "cloud_cover": 4.0,
                "resolution": 10,
                "crs": "EPSG:32643",
                "bounding_box": region,
                "bands": ["B2", "B3", "B4", "B8"],
                "product_id": "FAKE-S2",
            }
        if self._sar is not None:
            payload["sar"] = {
                "modality": "sar",
                "source": "sentinel-1",
                "satellite": "Sentinel-1",
                "collection": "COPERNICUS/S1_GRD",
                "file_path": str(self._sar),
                "downloaded": True,
                "capture_date": "2021-03-03T00:00:00Z",
                "polarization": ["VV", "VH"],
                "orbit": "DESCENDING",
                "resolution": 10,
                "crs": "EPSG:32643",
                "bounding_box": region,
                "bands": ["VV", "VH"],
                "product_id": "FAKE-S1",
            }
        return payload


def test_orchestrator_mock_success():
    m = MockGeeProvider()
    result = fetch_imagery(
        m, bounding_box=REGION, start_date="2021-01-01", end_date="2021-06-01"
    )
    assert result["source"] == "mock"
    assert len(result["images"]) == 2
    assert fetch_status(result) == "success"
    assert fetch_confidence(result) == 0.7
    # Mock images are never marked as downloaded/validated.
    for img in result["images"]:
        assert img["downloaded"] is False
        assert img["filePath"] is None
        assert img["validated"] is False


def test_orchestrator_fake_real_downloaded_and_validated(georeferenced_raster):
    provider = _GeeFakeProvider(
        optical_path=georeferenced_raster, sar_path=georeferenced_raster,
        date_gap=2,
    )
    result = fetch_imagery(
        provider, bounding_box=REGION, start_date="2021-01-01", end_date="2021-06-01"
    )
    assert result["source"] == "gee"
    assert len(result["images"]) == 2
    for img in result["images"]:
        assert img["downloaded"] is True
        assert img["validated"] is True
        assert Path(img["filePath"]).exists()
    # Clean real pair, no warnings, small date gap -> top confidence.
    assert fetch_status(result) == "success"
    assert fetch_confidence(result) == 1.0


def test_orchestrator_sar_keeps_sar_identity(georeferenced_raster):
    provider = _GeeFakeProvider(
        optical_path=georeferenced_raster, sar_path=georeferenced_raster
    )
    result = fetch_imagery(
        provider, bounding_box=REGION, start_date="2021-01-01", end_date="2021-06-01"
    )
    sar = next(i for i in result["images"] if i["modality"] == "sar")
    assert sar["source"] == "sentinel-1"
    assert sar["polarization"] == ["VV", "VH"]
    # Never pretend SAR is optical.
    assert sar["modality"] == "sar"


def test_orchestrator_partial_single_image(georeferenced_raster):
    provider = _GeeFakeProvider(optical_path=georeferenced_raster, sar_path=None)
    result = fetch_imagery(
        provider, bounding_box=REGION, start_date="2021-01-01", end_date="2021-06-01"
    )
    assert len(result["images"]) == 1
    assert fetch_status(result) == "partial"
    assert fetch_confidence(result) == 0.5


def test_orchestrator_no_imagery():
    class _Empty:
        def fetch_pair(self, region, start, end, preferred_date=None):
            return {"source": "gee", "optical": None, "sar": None,
                    "date_gap_days": None, "provider_warnings": []}

    with pytest.raises(FetchNoImageError):
        fetch_imagery(_Empty(), bounding_box=REGION, start_date="2021-01-01",
                      end_date="2021-06-01")


def test_orchestrator_unsupported_modality():
    class _Bad:
        def fetch_pair(self, region, start, end, preferred_date=None):
            return {
                "source": "gee",
                "optical": {"modality": "vlm", "source": "sentinel-2"},
                "sar": None,
                "date_gap_days": None,
                "provider_warnings": [],
            }

    with pytest.raises(FetchValidationError):
        fetch_imagery(_Bad(), bounding_box=REGION, start_date="2021-01-01",
                      end_date="2021-06-01")


def test_no_nan_or_infinity_serializable(georeferenced_raster):
    provider = _GeeFakeProvider(
        optical_path=georeferenced_raster, sar_path=georeferenced_raster,
        date_gap=2,
    )
    result = fetch_imagery(
        provider, bounding_box=REGION, start_date="2021-01-01", end_date="2021-06-01"
    )
    # Round-tripping through JSON must succeed with no NaN/Infinity tokens.
    raw = json.dumps(result)
    assert "NaN" not in raw and "Infinity" not in raw
    parsed = json.loads(raw)
    assert parsed["date_gap_days"] == 2


def test_confidence_deterministic():
    result = {
        "source": "mock", "images": [{}, {}], "warnings": [],
    }
    assert fetch_confidence(result) == 0.7
    assert fetch_confidence(result) == 0.7
