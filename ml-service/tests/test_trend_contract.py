"""Behavioral tests for the hardened /trend contract.

Covers the defects found in the trend audit:
- region bounds carried no CRS, so their coordinate system was ambiguous
- a caller-supplied CRS was silently reinterpreted as lon/lat
- the backend's AOI was dropped by the request schema and never applied
- a single observation produced direction="stable" and 0.0% change
- a two-observation comparison reported the same confidence as a fitted trend
"""

import pytest

from app.schemas.requests import TrendRequest
from app.tools.trend import (
    NATIVE_CRS,
    TrendComputationError,
    TrendValidationError,
    apply_aoi,
    compute_trend,
    trend_confidence,
    validate_region,
)

REGION = {
    "type": "Polygon",
    "coordinates": [
        [[77.0, 28.0], [77.2, 28.0], [77.2, 28.2], [77.0, 28.2], [77.0, 28.0]]
    ],
}
AOI = {
    "type": "Polygon",
    "coordinates": [
        [[77.05, 28.05], [77.10, 28.05], [77.10, 28.10], [77.05, 28.10], [77.05, 28.05]]
    ],
}
DISJOINT_AOI = {
    "type": "Polygon",
    "coordinates": [
        [[80.0, 10.0], [80.1, 10.0], [80.1, 10.1], [80.0, 10.1], [80.0, 10.0]]
    ],
}


class RecordingProvider:
    """Provider that records the geometry it was actually asked about."""

    source = "gee"

    def __init__(self, observations=None, label="gee"):
        self.source = label
        self.seen_region = None
        self._observations = observations if observations is not None else [
            {"date": f"2021-{m:02d}-15", "value": 0.40 + 0.01 * m, "valid_pixels": 120}
            for m in (1, 2, 3)
        ]

    def compute_trend(self, metric, region, start, end, interval="monthly"):
        self.seen_region = region
        return {
            "source": self.source,
            "collection": "COPERNICUS/S2_SR_HARMONIZED",
            "band_mapping": {metric: "B8"},
            "quality_mask": True,
            "observations": list(self._observations),
        }


# --------------------------------------------------------------------------- #
# Region CRS                                                                   #
# --------------------------------------------------------------------------- #


def test_region_bounds_carry_an_explicit_crs():
    """Bounds alone are ambiguous; the CRS must travel with them."""
    meta, _ = validate_region(REGION)
    assert meta["crs"] == NATIVE_CRS
    assert meta["bounds"] == {
        "west": 77.0, "south": 28.0, "east": 77.2, "north": 28.2
    }
    # The area unit is labelled so square degrees are not read as km².
    assert "square degrees" in meta["area_units"]


def test_declared_crs_is_reprojected_not_reinterpreted():
    """A polygon drawn in UTM metres must be converted, not read as lon/lat."""
    utm = {
        "type": "Polygon",
        "coordinates": [
            [[500000, 4600000], [510000, 4600000], [510000, 4610000],
             [500000, 4610000], [500000, 4600000]]
        ],
        "crs": "EPSG:32643",
    }
    meta, warnings = validate_region(utm)
    assert meta["crs"] == NATIVE_CRS
    west, south, east, north = (
        meta["bounds"]["west"], meta["bounds"]["south"],
        meta["bounds"]["east"], meta["bounds"]["north"],
    )
    # Reprojected UTM 43N lands in the Caspian region, not at lon=500000.
    assert -180 <= west <= 180 and -90 <= south <= 90
    assert west < east and south < north
    assert any("reprojected" in w for w in warnings)


def test_undeclared_projected_coordinates_are_rejected():
    """Metre coordinates with no CRS are refused rather than silently clipped."""
    bad = {
        "type": "Polygon",
        "coordinates": [
            [[500000, 4600000], [510000, 4600000], [510000, 4610000],
             [500000, 4610000], [500000, 4600000]]
        ],
    }
    with pytest.raises(TrendValidationError) as exc:
        validate_region(bad)
    assert "longitude out of range" in str(exc.value)
    # The error tells the caller how to fix it.
    assert "EPSG:4326" in str(exc.value)


def test_unrecognised_declared_crs_is_rejected():
    bad = dict(REGION)
    bad["crs"] = "NOT-A-REAL-CRS"
    with pytest.raises(TrendValidationError):
        validate_region(bad)


# --------------------------------------------------------------------------- #
# AOI                                                                         #
# --------------------------------------------------------------------------- #


def test_request_schema_accepts_an_aoi():
    """The backend's AOI must not be silently dropped by the request model."""
    req = TrendRequest(
        region=REGION, start_date="2021-01-01", end_date="2022-01-01",
        metric="ndvi", interval="monthly", aoi=AOI, aoi_crs="EPSG:4326",
    )
    assert req.aoi == AOI
    assert req.aoi_crs == "EPSG:4326"


def test_aoi_is_applied_to_the_provider_query():
    """The provider must be asked about the AOI, not the whole region."""
    provider = RecordingProvider()
    result = compute_trend(
        provider, metric="ndvi", region=REGION,
        start_date="2021-01-01", end_date="2021-12-31",
        interval="monthly", aoi=AOI,
    )
    # Assert on the geometry the provider received, not on ring ordering (shapely
    # is free to rotate a ring's starting vertex).
    from shapely.geometry import shape as _shape
    queried = _shape(provider.seen_region).bounds
    assert queried[0] == pytest.approx(77.05)
    assert queried[1] == pytest.approx(28.05)
    assert queried[2] == pytest.approx(77.10)
    assert queried[3] == pytest.approx(28.10)
    scope = result["aoiScope"]
    assert scope["aoiApplied"] is True
    assert scope["aoiScope"] == "aoi"
    assert scope["aoiStatus"] == "applied"
    assert scope["crs"] == NATIVE_CRS
    # The requested region is still reported, alongside what was analysed.
    assert result["region"]["bounds"]["west"] == 77.0
    assert result["analyzedRegion"]["bounds"]["west"] == pytest.approx(77.05)


def test_no_aoi_means_region_scope_and_is_reported_as_such():
    provider = RecordingProvider()
    result = compute_trend(
        provider, metric="ndvi", region=REGION,
        start_date="2021-01-01", end_date="2021-12-31", interval="monthly",
    )
    assert result["aoiScope"]["aoiApplied"] is False
    assert result["aoiScope"]["aoiScope"] == "region"
    # The provider saw the full region.
    assert provider.seen_region["coordinates"][0][0][0] == 77.0


def test_aoi_larger_than_region_is_clipped_to_the_region():
    big = {
        "type": "Polygon",
        "coordinates": [
            [[70.0, 20.0], [80.0, 20.0], [80.0, 30.0], [70.0, 30.0], [70.0, 20.0]]
        ],
    }
    provider = RecordingProvider()
    result = compute_trend(
        provider, metric="ndvi", region=REGION,
        start_date="2021-01-01", end_date="2021-12-31", aoi=big,
    )
    assert result["aoiScope"]["aoiApplied"] is True
    # Never larger than the region it is clipped to.
    assert result["analyzedRegion"]["bounds"] == result["region"]["bounds"]


def test_disjoint_aoi_fails_instead_of_silently_using_the_whole_region():
    provider = RecordingProvider()
    with pytest.raises(TrendValidationError) as exc:
        compute_trend(
            provider, metric="ndvi", region=REGION,
            start_date="2021-01-01", end_date="2021-12-31", aoi=DISJOINT_AOI,
        )
    assert "does not intersect" in str(exc.value)


def test_aoi_touching_only_the_boundary_fails():
    edge = {
        "type": "Polygon",
        "coordinates": [
            [[77.2, 28.0], [77.3, 28.0], [77.3, 28.2], [77.2, 28.2], [77.2, 28.0]]
        ],
    }
    with pytest.raises(TrendValidationError):
        apply_aoi(REGION, edge)


def test_invalid_aoi_type_is_rejected():
    with pytest.raises(TrendValidationError):
        apply_aoi(REGION, {"type": "Point", "coordinates": [77.0, 28.0]})


def test_no_observations_under_a_defined_aoi_reports_the_aoi():
    """An empty AOI result must not read as an empty region result."""
    provider = RecordingProvider(observations=[])
    with pytest.raises(TrendComputationError) as exc:
        compute_trend(
            provider, metric="ndvi", region=REGION,
            start_date="2021-01-01", end_date="2021-12-31", aoi=AOI,
        )
    assert "AOI" in str(exc.value)


# --------------------------------------------------------------------------- #
# Insufficient data                                                           #
# --------------------------------------------------------------------------- #


def test_one_observation_yields_no_direction_and_no_change():
    obs = [{"date": "2021-01-01", "value": 0.4, "valid_pixels": 10}]
    result = compute_trend(
        RecordingProvider(obs), metric="ndvi", region=REGION,
        start_date="2021-01-01", end_date="2021-02-01",
    )
    trend = result["trend"]
    assert trend["observation_count"] == 1
    assert trend["direction"] == "insufficient-data"
    assert trend["percentage_change"] is None
    assert trend["slope"] is None
    assert trend["sufficient_for_trend"] is False


def test_two_observations_are_flagged_as_a_comparison():
    obs = [
        {"date": "2021-01-01", "value": 0.40, "valid_pixels": 10},
        {"date": "2021-02-01", "value": 0.50, "valid_pixels": 10},
    ]
    trend = compute_trend(
        RecordingProvider(obs), metric="ndvi", region=REGION,
        start_date="2021-01-01", end_date="2021-03-01",
    )["trend"]
    assert trend["sufficient_for_trend"] is False
    assert trend["percentage_change"] == pytest.approx(25.0)
    assert "comparison" in (trend["note"] or "").lower()


def test_three_observations_support_a_trend():
    obs = [
        {"date": "2021-01-01", "value": 0.40, "valid_pixels": 10},
        {"date": "2021-02-01", "value": 0.45, "valid_pixels": 10},
        {"date": "2021-03-01", "value": 0.50, "valid_pixels": 10},
    ]
    trend = compute_trend(
        RecordingProvider(obs), metric="ndvi", region=REGION,
        start_date="2021-01-01", end_date="2021-04-01",
    )["trend"]
    assert trend["sufficient_for_trend"] is True
    assert trend["direction"] == "increasing"


# --------------------------------------------------------------------------- #
# Confidence                                                                   #
# --------------------------------------------------------------------------- #


def _base_result(obs, label="gee", end="2021-04-01"):
    return compute_trend(
        RecordingProvider(obs, label=label), metric="ndvi", region=REGION,
        start_date="2021-01-01", end_date=end,
    )


def test_insufficient_observations_do_not_report_full_confidence():
    """A two-point comparison cannot carry a fitted trend's confidence.

    Each case uses a date range that exactly covers its observations, so neither
    is penalised by an unrelated missing-period warning.
    """
    two = [
        {"date": "2021-01-01", "value": 0.40, "valid_pixels": 10},
        {"date": "2021-02-01", "value": 0.45, "valid_pixels": 10},
    ]
    three = two + [{"date": "2021-03-01", "value": 0.50, "valid_pixels": 10}]
    comparison_conf = trend_confidence(_base_result(two, end="2021-02-01"))
    trend_conf = trend_confidence(_base_result(three, end="2021-03-01"))
    assert comparison_conf < trend_conf
    assert trend_conf == 1.0


def test_confidence_is_deterministic():
    three = [
        {"date": "2021-01-01", "value": 0.40, "valid_pixels": 10},
        {"date": "2021-02-01", "value": 0.45, "valid_pixels": 10},
        {"date": "2021-03-01", "value": 0.50, "valid_pixels": 10},
    ]
    assert trend_confidence(_base_result(three, end="2021-03-01")) == \
        trend_confidence(_base_result(three, end="2021-03-01"))


def test_mock_source_is_never_full_confidence():
    three = [
        {"date": "2021-01-01", "value": 0.40, "valid_pixels": 10},
        {"date": "2021-02-01", "value": 0.45, "valid_pixels": 10},
        {"date": "2021-03-01", "value": 0.50, "valid_pixels": 10},
    ]
    assert trend_confidence(_base_result(three, label="mock", end="2021-03-01")) < 1.0
