"""Historical trend analysis core (network-free).

This module owns the deterministic parts of ``/trend``:

- region validation (GeoJSON Polygon / MultiPolygon)
- date-range validation
- metric validation
- time-series normalisation (chronological order, missing-period handling)
- deterministic trend statistics (slope via linear regression, percentage change,
  direction)

It deliberately does NOT talk to Google Earth Engine. It consumes a provider
(``app/services/gee_client.py``) that returns a normalised observation list, so the
trend math is fully unit-testable without credentials or network.

This is quantitative temporal evidence only — no semantic conclusions ("deforestation
happened", "flooding occurred") are drawn. The Agent / ML / VLM layer interprets later.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Iterator

import numpy as np
from shapely.geometry import shape

# Supported optical trend metrics (documented). Unsupported metrics fail, never
# silently substituted.
SUPPORTED_METRICS = {"ndvi", "ndwi"}

# Trend-direction tolerance on the total index change (NDVI/NDWI range is -1..+1,
# so 0.02 is a 2% change — documented interpretation of "near-zero"/stable).
DIRECTION_TOLERANCE = 0.02

# Documented upper bound on a requested trend span (years) to keep GEE queries
# reasonable and avoid unbounded cost.
MAX_SPAN_YEARS = 30


class TrendError(Exception):
    """Base error for trend computation failures."""


class TrendValidationError(TrendError):
    """Raised when region, dates, or metric are invalid."""


class TrendComputationError(TrendError):
    """Raised when a trend cannot be computed."""


# --------------------------------------------------------------------------- #
# Region validation                                                           #
# --------------------------------------------------------------------------- #


def validate_region(geojson: Any) -> tuple[dict[str, Any], list[str]]:
    """Validate a GeoJSON Polygon/MultiPolygon region.

    Returns (region_meta, warnings) on success. Raises TrendValidationError with a
    clear message on invalid/unsupported geometry. Does not silently repair
    geometry.
    """
    warnings: list[str] = []
    if not isinstance(geojson, dict):
        raise TrendValidationError("region must be a GeoJSON geometry object.")

    gtype = geojson.get("type")
    if gtype not in ("Polygon", "MultiPolygon"):
        raise TrendValidationError(
            f"Unsupported region type '{gtype}'. /trend supports a GeoJSON "
            "Polygon or MultiPolygon geometry."
        )

    try:
        geom = shape(geojson)
    except Exception as exc:
        raise TrendValidationError(f"Invalid GeoJSON geometry: {exc}") from exc

    if geom.is_empty:
        raise TrendValidationError("region geometry is empty.")
    if not geom.is_valid:
        raise TrendValidationError(
            "region geometry is invalid (shapely reports is_valid=False)."
        )

    # Coordinate range checks (WGS84 assumed for GEE queries).
    if not geom.is_valid:
        raise TrendValidationError("region geometry is invalid.")
    minx, miny, maxx, maxy = geom.bounds
    for label, mn, mx in (("longitude", minx, maxx), ("latitude", miny, maxy)):
        if mn < -180 or mx > 180:
            raise TrendValidationError(
                f"region {label} out of range [-180, 180]: [{mn}, {mx}]."
            )
    for label, mn, mx in (("latitude", miny, maxy),):
        if mn < -90 or mx > 90:
            raise TrendValidationError(
                f"region {label} out of range [-90, 90]: [{mn}, {mx}]."
            )

    centroid = geom.centroid
    area_deg2 = abs(geom.area)
    meta = {
        "type": gtype,
        "bounds": {
            "west": float(minx), "south": float(miny),
            "east": float(maxx), "north": float(maxy),
        },
        "centroid": {"lat": float(centroid.y), "lon": float(centroid.x)},
        "area_deg2": float(area_deg2),
    }
    if area_deg2 <= 0:
        raise TrendValidationError("region geometry has zero area.")

    # The coordinates are already validated by shapely; a 4-coordinate ring is
    # expected for closed polygons. No silent repair is performed.
    return meta, warnings


# --------------------------------------------------------------------------- #
# Date-range validation                                                       #
# --------------------------------------------------------------------------- #


def parse_date_range(start: str, end: str) -> tuple[_dt.date, _dt.date, list[str]]:
    """Validate an ISO start/end date pair.

    Returns (start_date, end_date, warnings). Raises TrendValidationError on any
    invalid range. Future dates and over-long spans are rejected.
    """
    warnings: list[str] = []
    for label, val in (("start_date", start), ("end_date", end)):
        if val is None or (isinstance(val, str) and not val.strip()):
            raise TrendValidationError(f"{label} is required.")
    try:
        start_dt = _dt.date.fromisoformat(str(start))
        end_dt = _dt.date.fromisoformat(str(end))
    except ValueError as exc:
        raise TrendValidationError(
            f"Invalid date format (expected ISO YYYY-MM-DD): {exc}"
        ) from exc

    if start_dt >= end_dt:
        raise TrendValidationError(
            "start_date must be earlier than end_date (start < end)."
        )

    today = _dt.date.today()
    if end_dt > today:
        raise TrendValidationError(
            f"end_date ({end}) is in the future; /trend does not query future dates."
        )

    span_days = (end_dt - start_dt).days
    if span_days > MAX_SPAN_YEARS * 365:
        raise TrendValidationError(
            f"Requested span (~{span_days} days) exceeds the supported maximum "
            f"of {MAX_SPAN_YEARS} years."
        )
    return start_dt, end_dt, warnings


def validate_metric(metric: str) -> None:
    """Validate the requested metric; raise on unsupported values."""
    m = (metric or "").lower()
    if m not in SUPPORTED_METRICS:
        raise TrendValidationError(
            f"Unsupported metric '{metric}'. Supported: {sorted(SUPPORTED_METRICS)}."
            " The service never silently substitutes another metric."
        )


# --------------------------------------------------------------------------- #
# Temporal bucketing                                                          #
# --------------------------------------------------------------------------- #


def _iter_buckets(start_dt: _dt.date, end_dt: _dt.date, interval: str) -> Iterator[tuple[str, str]]:
    """Yield (label, iso_date) for each bucket covering [start_dt, end_dt]."""
    if interval == "yearly":
        for year in range(start_dt.year, end_dt.year + 1):
            yield str(year), f"{year}-06-30"
        return
    # monthly (default)
    month = _dt.date(start_dt.year, start_dt.month, 1)
    while month <= end_dt:
        yield month.strftime("%Y-%m"), month.isoformat()
        nxt = month + _dt.timedelta(days=32)
        month = _dt.date(nxt.year, nxt.month, 1)


def normalize_series(
    observations: list[dict[str, Any]],
    start: str,
    end: str,
    interval: str,
) -> tuple[list[dict[str, Any]], int, list[str]]:
    """Build a chronological, gap-free time series from provider observations.

    Missing buckets (cloud / no imagery / insufficient pixels) are represented
    honestly as ``{"value": null, "status": "missing"}`` — never fabricated or
    interpolated. Duplicate timestamps keep the last value (documented), with a
    warning.

    Returns (series, missing_count, warnings).
    """
    warnings: list[str] = []
    start_dt = _dt.date.fromisoformat(start)
    end_dt = _dt.date.fromisoformat(end)

    # Index provider observations by label (last wins on duplicates).
    by_label: dict[str, dict[str, Any]] = {}
    for obs in observations or []:
        date = obs.get("date")
        if not date:
            continue
        label, _ = _bucket_label(date, interval, start_dt)
        if label in by_label:
            warnings.append(f"Duplicate timestamp '{date}' collapsed (last kept).")
        by_label[label] = {
            "date": date,
            "value": obs.get("value"),
            "valid_pixels": obs.get("valid_pixels"),
        }

    series: list[dict[str, Any]] = []
    missing = 0
    for label, iso in _iter_buckets(start_dt, end_dt, interval):
        existing = by_label.get(label)
        value = existing["value"] if existing else None
        valid_px = existing["valid_pixels"] if existing else None
        if value is None:
            missing += 1
            series.append(
                {
                    "date": iso,
                    "value": None,
                    "valid_pixels": valid_px,
                    "status": "missing",
                }
            )
        else:
            series.append(
                {
                    "date": iso,
                    "value": float(value),
                    "valid_pixels": valid_px,
                    "status": "ok",
                }
            )

    return series, missing, warnings


def _bucket_label(date_str: str, interval: str, start_dt: _dt.date) -> tuple[str, str]:
    """Map a provider date string onto a bucket (label, iso)."""
    if interval == "yearly":
        year = date_str[:4]
        return year, f"{year}-06-30"
    # monthly: fall back to the provider's own representation if it looks like YYYY-MM.
    if len(date_str) >= 7:
        month = date_str[:7]
        return month, f"{month}-01"
    dt = _dt.date.fromisoformat(date_str)
    return dt.strftime("%Y-%m"), dt.isoformat()


# --------------------------------------------------------------------------- #
# Trend statistics                                                            #
# --------------------------------------------------------------------------- #


def trend_statistics(series: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute deterministic trend statistics from a series.

    Slope uses simple linear regression: ``value = slope * day_index + intercept``,
    where ``day_index`` is days since the first observation (documented). Handles
    zero first value for percentage change safely (returns null + note).
    """
    valid = [
        (i, s["date"], s["value"])
        for i, s in enumerate(series)
        if s.get("value") is not None
    ]
    stats: dict[str, Any] = {
        "observation_count": len(valid),
        "missing_count": sum(1 for s in series if s.get("value") is None),
    }

    if not valid:
        stats.update(
            {
                "first_value": None,
                "last_value": None,
                "min": None,
                "max": None,
                "mean": None,
                "slope": None,
                "slope_units": None,
                "percentage_change": None,
                "direction": "no-data",
                "note": "No valid observations; trend could not be quantified.",
            }
        )
        return stats

    values = np.array([v for _, _, v in valid], dtype=np.float64)
    dates = [d for _, d, _ in valid]
    first_dt = _dt.date.fromisoformat(dates[0])
    day_index = np.array(
        [(_dt.date.fromisoformat(d) - first_dt).days for d in dates], dtype=np.float64
    )

    first_value = float(values[0])
    last_value = float(values[-1])

    slope = None
    if len(values) >= 2 and (day_index.max() - day_index.min()) > 0:
        slope, _ = np.polyfit(day_index, values, 1)  # least squares
        slope = float(slope)

    # Percentage change, safe for first_value == 0.
    percentage_change = None
    note = ""
    if abs(first_value) > 1e-12:
        percentage_change = ((last_value - first_value) / abs(first_value)) * 100.0
    else:
        note = "percentage_change omitted because first_value == 0 (no safe divide)."

    # Direction from total change over the span (documented tolerance).
    total_change = last_value - first_value
    if abs(total_change) < DIRECTION_TOLERANCE:
        direction = "stable"
    elif total_change > 0:
        direction = "increasing"
    else:
        direction = "decreasing"

    stats.update(
        {
            "first_value": round(first_value, 6),
            "last_value": round(last_value, 6),
            "min": round(float(np.min(values)), 6),
            "max": round(float(np.max(values)), 6),
            "mean": round(float(np.mean(values)), 6),
            "slope": round(slope, 8) if slope is not None else None,
            "slope_units": "per day (linear regression on days since first observation)",
            "percentage_change": (
                round(percentage_change, 6) if percentage_change is not None else None
            ),
            "direction": direction,
            "note": note or None,
        }
    )
    return stats


# --------------------------------------------------------------------------- #
# Orchestrator                                                                #
# --------------------------------------------------------------------------- #


def compute_trend(
    provider,
    *,
    metric: str,
    region: dict[str, Any],
    start_date: str,
    end_date: str,
    interval: str = "monthly",
) -> dict[str, Any]:
    """Run the full trend pipeline against a given provider."""
    metric_p = (metric or "").lower()
    validate_metric(metric_p)
    if interval not in ("monthly", "yearly"):
        raise TrendValidationError(
            f"Unsupported interval '{interval}'. Supported: monthly, yearly."
        )
    region_meta, region_warnings = validate_region(region)
    start_dt, end_dt, date_warnings = parse_date_range(start_date, end_date)
    start_iso, end_iso = start_dt.isoformat(), end_dt.isoformat()

    provider_payload = provider.compute_trend(
        metric_p, region, start_iso, end_iso, interval=interval
    )
    observations = provider_payload.get("observations", [])
    provider_warnings = list(provider_payload.get("provider_warnings", []))

    series, missing, series_warnings = normalize_series(
        observations, start_iso, end_iso, interval
    )
    stats = trend_statistics(series)

    warnings = (
        region_warnings
        + date_warnings
        + provider_warnings
        + series_warnings
    )
    source = provider_payload.get("source", "unknown")

    if not any(s.get("value") is not None for s in series):
        raise TrendComputationError(
            "No valid observations were returned for the requested region/date "
            "range/metric. Nothing can be quantified."
        )

    result = {
        "metric": metric_p,
        "region": region_meta,
        "date_range": {"start": start_iso, "end": end_iso},
        "interval": interval,
        "source": source,
        "collection": provider_payload.get("collection"),
        "band_mapping": provider_payload.get("band_mapping"),
        "quality_mask": provider_payload.get("quality_mask"),
        "series": series,
        "trend": stats,
        "warnings": warnings,
    }
    return result


def trend_confidence(result: dict[str, Any]) -> float:
    """Deterministic confidence (reliability, not statistical significance).

    1.0 if all inputs valid, no warnings, and real (non-mock) observations exist.
    0.8 if any warnings, missing periods, or mock/fixture source.
    0.0 only reached externally on failure (no valid result here).
    """
    if result.get("source") != "gee":
        return 0.8
    if result.get("warnings"):
        return 0.8
    trend = result.get("trend", {})
    if not trend.get("observation_count"):
        return 0.8
    if trend.get("missing_count"):
        return 0.8
    return 1.0
