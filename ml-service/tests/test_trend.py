"""Unit tests for historical trend analysis (app/tools/trend.py + providers).

These tests do NOT require live GEE credentials. They use deterministic fake /
mock providers so the trend logic is verified independently of the GEE network.
"""

from __future__ import annotations

import math

import pytest

from app.services.gee_client import (
    GeeAuthError,
    GeeQueryError,
    MockGeeProvider,
    RealGeeProvider,
    get_provider,
)
from app.tools import trend
from app.tools.trend import (
    TrendComputationError,
    TrendValidationError,
    compute_trend,
    trend_confidence,
)

REGION = {
    "type": "Polygon",
    "coordinates": [[[78.0, 28.0], [78.5, 28.0], [78.5, 28.5], [78.0, 28.5], [78.0, 28.0]]],
}


class FakeProvider:
    """Configurable deterministic provider returning a fixed observation list."""

    def __init__(self, observations, source="gee", warnings=None, collection="fake"):
        self.observations = observations
        self.source = source
        self.warnings = warnings or []
        self.collection = collection

    def compute_trend(self, metric, region, start, end, interval="monthly"):
        return {
            "source": self.source,
            "metric": metric,
            "interval": interval,
            "collection": self.collection,
            "band_mapping": {"nir": "B8", "red": "B4"} if metric == "ndvi"
                            else {"green": "B3", "nir": "B8"},
            "quality_mask": "test",
            "observations": self.observations,
            "provider_warnings": self.warnings,
        }


class FailingProvider:
    def compute_trend(self, metric, region, start, end, interval="monthly"):
        raise GeeQueryError("simulated GEE query failure")


def _flat(result):
    """Return set-like walk checking for NaN/Infinity in floats."""
    bad = []

    def walk(x):
        if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
            bad.append(x)
        elif isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(result)
    return bad


# --------------------------------------------------------------------------- #
# Providers                                                                   #
# --------------------------------------------------------------------------- #


def test_get_provider_mode_selection():
    assert isinstance(get_provider("mock"), MockGeeProvider)
    assert isinstance(get_provider("dev"), MockGeeProvider)
    assert isinstance(get_provider("real"), RealGeeProvider)


def test_real_provider_fails_cleanly_without_credentials():
    # Partial credentials -> immediate auth error, no network attempted.
    with pytest.raises(GeeAuthError):
        RealGeeProvider(
            credentials={"GEE_SERVICE_ACCOUNT_KEY_PATH": "/tmp/nonexistent.json"}
        )._initialise()


def test_provider_query_error_is_structured():
    with pytest.raises(GeeQueryError):
        compute_trend(FailingProvider(), metric="ndvi", region=REGION,
                      start_date="2021-01-01", end_date="2022-01-01")


# --------------------------------------------------------------------------- #
# Happy paths                                                                 #
# --------------------------------------------------------------------------- #


def test_valid_mocked_ndvi_series():
    res = compute_trend(MockGeeProvider(), metric="ndvi", region=REGION,
                        start_date="2021-01-01", end_date="2021-06-01")
    assert res["metric"] == "ndvi"
    assert res["source"] == "mock"
    assert res["series"]
    # 6 monthly buckets from Jan..Jun
    assert len(res["series"]) == 6
    dates = [s["date"] for s in res["series"]]
    assert dates == sorted(dates)
    assert all(s["status"] == "ok" for s in res["series"])
    assert res["trend"]["observation_count"] == 6


def test_increasing_trend():
    res = compute_trend(MockGeeProvider(), metric="ndvi", region=REGION,
                        start_date="2021-01-01", end_date="2023-12-01")
    assert res["trend"]["direction"] == "increasing"
    assert res["trend"]["slope"] is not None and res["trend"]["slope"] > 0


def test_decreasing_trend():
    res = compute_trend(MockGeeProvider(), metric="ndwi", region=REGION,
                        start_date="2021-01-01", end_date="2023-12-01")
    assert res["trend"]["direction"] == "decreasing"
    assert res["trend"]["slope"] < 0


def test_stable_trend():
    obs = [
        {"date": "2021-01-01", "value": 0.5, "valid_pixels": 10},
        {"date": "2021-02-01", "value": 0.5, "valid_pixels": 10},
        {"date": "2021-03-01", "value": 0.5, "valid_pixels": 10},
    ]
    res = compute_trend(FakeProvider(obs), metric="ndvi", region=REGION,
                        start_date="2021-01-01", end_date="2021-03-01")
    assert res["trend"]["direction"] == "stable"
    assert res["trend"]["slope"] == pytest.approx(0.0, abs=1e-9)


def test_chronological_ordering(mock_series=None):
    obs = [
        {"date": "2021-03-01", "value": 0.6, "valid_pixels": 10},
        {"date": "2021-01-01", "value": 0.4, "valid_pixels": 10},
        {"date": "2021-02-01", "value": 0.5, "valid_pixels": 10},
    ]
    res = compute_trend(FakeProvider(obs), metric="ndvi", region=REGION,
                        start_date="2021-01-01", end_date="2021-03-01")
    dates = [s["date"] for s in res["series"]]
    assert dates == sorted(dates)


def test_duplicate_timestamps_last_wins():
    obs = [
        {"date": "2021-01-01", "value": 0.1, "valid_pixels": 10},
        {"date": "2021-01-01", "value": 0.9, "valid_pixels": 10},
    ]
    res = compute_trend(FakeProvider(obs), metric="ndvi", region=REGION,
                        start_date="2021-01-01", end_date="2021-02-01")
    # January collides (last wins); February is missing.
    assert res["series"][0]["value"] == pytest.approx(0.9)
    assert res["series"][1]["value"] is None
    assert any("Duplicate" in w for w in res["warnings"])


def test_missing_observations_are_honest():
    obs = [
        {"date": "2021-01-01", "value": 0.4, "valid_pixels": 10},
        # Feb missing (cloud / no imagery)
        {"date": "2021-03-01", "value": 0.6, "valid_pixels": 10},
    ]
    res = compute_trend(FakeProvider(obs), metric="ndvi", region=REGION,
                        start_date="2021-01-01", end_date="2021-03-01")
    missing = [s for s in res["series"] if s["status"] == "missing"]
    assert len(missing) == 1
    assert missing[0]["date"] == "2021-02-01"
    assert missing[0]["value"] is None
    assert res["trend"]["missing_count"] == 1


def test_quality_masking_invalid_observations_excluded():
    # "Quality masking" manifesting as missing/None observations for bad periods.
    obs = [
        {"date": "2021-01-01", "value": 0.4, "valid_pixels": 10},
        {"date": "2021-02-01", "value": None, "valid_pixels": 0},  # cloud-covered
        {"date": "2021-03-01", "value": 0.6, "valid_pixels": 10},
    ]
    res = compute_trend(FakeProvider(obs), metric="ndvi", region=REGION,
                        start_date="2021-01-01", end_date="2021-03-01")
    # The None value must not count as a valid observation.
    assert res["trend"]["observation_count"] == 2
    assert res["trend"]["missing_count"] == 1
    assert res["series"][1]["value"] is None


def test_no_nan_infinity_leaks():
    res = compute_trend(MockGeeProvider(), metric="ndvi", region=REGION,
                        start_date="2021-01-01", end_date="2023-01-01")
    assert _flat(trend_confidence(res)) == []
    assert _flat(res) == []


def test_deterministic_confidence():
    a = compute_trend(MockGeeProvider(), metric="ndvi", region=REGION,
                      start_date="2021-01-01", end_date="2022-01-01")
    b = compute_trend(MockGeeProvider(), metric="ndvi", region=REGION,
                      start_date="2021-01-01", end_date="2022-01-01")
    assert trend_confidence(a) == trend_confidence(b)
    # Mock source is explicitly lower confidence than real, clean data.
    assert trend_confidence(a) == 0.8


# --------------------------------------------------------------------------- #
# Validation failures                                                         #
# --------------------------------------------------------------------------- #


def test_invalid_region():
    with pytest.raises(TrendValidationError):
        compute_trend(MockGeeProvider(), metric="ndvi",
                      region={"type": "Point", "coordinates": [0, 0]},
                      start_date="2021-01-01", end_date="2022-01-01")


def test_invalid_geometry_empty():
    with pytest.raises(TrendValidationError):
        compute_trend(MockGeeProvider(), metric="ndvi",
                      region={"type": "Polygon", "coordinates": []},
                      start_date="2021-01-01", end_date="2022-01-01")


def test_invalid_date_range():
    with pytest.raises(TrendValidationError):
        compute_trend(MockGeeProvider(), metric="ndvi", region=REGION,
                      start_date="not-a-date", end_date="2022-01-01")


def test_start_gte_end():
    with pytest.raises(TrendValidationError):
        compute_trend(MockGeeProvider(), metric="ndvi", region=REGION,
                      start_date="2022-01-01", end_date="2022-01-01")


def test_unsupported_metric():
    with pytest.raises(TrendValidationError):
        compute_trend(MockGeeProvider(), metric="ndbi", region=REGION,
                      start_date="2021-01-01", end_date="2022-01-01")


def test_no_observations_fails():
    with pytest.raises(TrendComputationError):
        compute_trend(FakeProvider([]), metric="ndvi", region=REGION,
                      start_date="2021-01-01", end_date="2022-01-01")


def test_insufficient_observations_single_point():
    obs = [{"date": "2021-01-01", "value": 0.4, "valid_pixels": 10}]
    res = compute_trend(FakeProvider(obs), metric="ndvi", region=REGION,
                        start_date="2021-01-01", end_date="2021-02-01")
    assert res["trend"]["slope"] is None
    assert res["trend"]["observation_count"] == 1
    assert res["trend"]["percentage_change"] == 0.0
    assert _flat(res) == []


def test_first_value_zero_no_division_by_zero():
    obs = [
        {"date": "2021-01-01", "value": 0.0, "valid_pixels": 10},
        {"date": "2021-02-01", "value": 0.5, "valid_pixels": 10},
    ]
    res = compute_trend(FakeProvider(obs), metric="ndvi", region=REGION,
                        start_date="2021-01-01", end_date="2021-02-01")
    assert res["trend"]["percentage_change"] is None
    assert "percentage_change omitted" in (res["trend"]["note"] or "")


def test_region_validation_lat_out_of_range():
    bad = {
        "type": "Polygon",
        "coordinates": [[[78.0, 28.0], [78.5, 28.0], [78.5, 95.0], [78.0, 95.0], [78.0, 28.0]]],
    }
    with pytest.raises(TrendValidationError):
        compute_trend(MockGeeProvider(), metric="ndvi", region=bad,
                      start_date="2021-01-01", end_date="2022-01-01")


def test_unsupported_interval():
    with pytest.raises(TrendValidationError):
        compute_trend(MockGeeProvider(), metric="ndvi", region=REGION,
                      start_date="2021-01-01", end_date="2022-01-01",
                      interval="daily")
