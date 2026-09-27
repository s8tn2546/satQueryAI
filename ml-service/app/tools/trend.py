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
import shapely.ops
from shapely.geometry import mapping, shape
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

# /trend queries Google Earth Engine with ``ee.Geometry(region)``. GEE
# interprets a bare GeoJSON geometry as WGS84 longitude/latitude degrees
# (EPSG:4326), so that is the CRS the service actually works in and the CRS in
# which every reported ``region.bounds`` is expressed.
NATIVE_CRS = "EPSG:4326"

# Minimum distinct observations before a direction may be inferred. Below this
# the series supports comparison, not trend.
MIN_OBSERVATIONS_FOR_TREND = 3


def _to_wgs84(geom, declared_crs: str | None):
    """Return ``(geometry_in_wgs84, crs_label)`` for a caller-supplied region.

    A GeoJSON geometry carries no CRS field of its own, so an absent
    ``declared_crs`` means RFC 7946 WGS84 lon/lat — which is what the range
    checks below verify. When a caller *does* declare a CRS (e.g. a polygon drawn
    in UTM metres and posted as ``{"type": "Polygon", ..., "crs": "EPSG:32643"}``)
    the coordinates are reprojected rather than reinterpreted, so a metric value
    can never be computed over the wrong ground.
    """
    if declared_crs is None:
        return geom, NATIVE_CRS
    try:
        from pyproj import CRS as _CRS
        from pyproj import Transformer as _Transformer
    except ImportError as exc:  # pragma: no cover - pyproj is a hard dependency
        raise TrendValidationError(
            "A region CRS was declared but pyproj is unavailable to reproject it."
        ) from exc
    try:
        source = _CRS.from_user_input(declared_crs)
    except Exception as exc:
        raise TrendValidationError(
            f"Unrecognised region CRS '{declared_crs}': {exc}"
        ) from exc
    if source.equals(_CRS.from_user_input(NATIVE_CRS)):
        return geom, NATIVE_CRS
    transformer = _Transformer.from_crs(source, _CRS.from_user_input(NATIVE_CRS),
                                        always_xy=True)
    return (
        shapely.ops.transform(transformer.transform, geom),
        NATIVE_CRS,
    )


def validate_region(geojson: Any) -> tuple[dict[str, Any], list[str]]:
    """Validate a GeoJSON Polygon/MultiPolygon region.

    Returns (region_meta, warnings) on success. Raises TrendValidationError with a
    clear message on invalid/unsupported geometry. Does not silently repair
    geometry.

    ``region_meta`` always carries an explicit ``crs`` alongside ``bounds``, so a
    consumer never has to assume what the numbers are in.
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

    # A CRS declared on the geometry (non-standard GeoJSON, but clients send it)
    # is honoured by reprojection, never ignored.
    declared_crs = geojson.get("crs")
    if isinstance(declared_crs, dict):
        # GeoJSON-style crs member: {"type": "name", "properties": {"name": ...}}
        name = (declared_crs.get("properties") or {}).get("name")
        declared_crs = name if isinstance(name, str) else None

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

    # Reproject before the range checks: a UTM polygon is not out of range, it is
    # simply not in the CRS the range check is written for.
    geom, crs_label = _to_wgs84(geom, declared_crs)
    if declared_crs is not None and crs_label == NATIVE_CRS and not geom.is_valid:
        raise TrendValidationError("region geometry is invalid after reprojection.")
    if geom.is_empty:
        raise TrendValidationError("region geometry is empty after reprojection.")

    minx, miny, maxx, maxy = geom.bounds
    for label, mn, mx in (("longitude", minx, maxx),):
        if mn < -180 or mx > 180:
            raise TrendValidationError(
                f"region {label} out of range [-180, 180]: [{mn}, {mx}]. "
                "Coordinates must be WGS84 longitude; declare the region's CRS "
                "if it is not already EPSG:4326."
            )
    for label, mn, mx in (("latitude", miny, maxy),):
        if mn < -90 or mx > 90:
            raise TrendValidationError(
                f"region {label} out of range [-90, 90]: [{mn}, {mx}]. "
                "Coordinates must be WGS84 latitude; declare the region's CRS "
                "if it is not already EPSG:4326."
            )

    centroid = geom.centroid
    area_deg2 = abs(geom.area)
    meta = {
        "type": gtype,
        # Bounds and the label describing them, always together. Reporting bounds
        # without a CRS is what made the trend contract ambiguous.
        "bounds": {
            "west": float(minx), "south": float(miny),
            "east": float(maxx), "north": float(maxy),
        },
        "crs": crs_label,
        "centroid": {"lat": float(centroid.y), "lon": float(centroid.x)},
        # Square degrees, not square kilometres: a degree is not a distance.
        "area_deg2": float(area_deg2),
        "area_units": "square degrees (EPSG:4326); not a ground area",
    }
    if area_deg2 <= 0:
        raise TrendValidationError("region geometry has zero area.")

    if declared_crs is not None:
        warnings.append(
            f"Region was supplied in {declared_crs} and reprojected to {NATIVE_CRS} "
            "for analysis; reported bounds are in " + NATIVE_CRS + "."
        )

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

    Insufficient data is reported as such rather than resolved into a direction.
    With a single observation there is nothing to compare, so ``direction`` is
    ``"insufficient-data"`` and ``percentage_change`` is ``None`` — reporting
    "stable" or 0.0% there would assert a flat trend that was never observed.
    Two observations support a comparison but not a trend, which
    ``sufficient_for_trend`` records.
    """
    valid = [
        (i, s["date"], s["value"])
        for i, s in enumerate(series)
        if s.get("value") is not None
    ]
    stats: dict[str, Any] = {
        "observation_count": len(valid),
        "missing_count": sum(1 for s in series if s.get("value") is None),
        "sufficient_for_trend": len(valid) >= MIN_OBSERVATIONS_FOR_TREND,
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

    # A single observation has no "first vs last" to compare: the two are the
    # same point, so any percentage would be a fabricated 0.0.
    if len(values) < 2:
        stats.update(
            {
                "first_value": round(first_value, 6),
                "last_value": round(first_value, 6),
                "min": round(float(np.min(values)), 6),
                "max": round(float(np.max(values)), 6),
                "mean": round(float(np.mean(values)), 6),
                "slope": None,
                "slope_units": None,
                "percentage_change": None,
                "direction": "insufficient-data",
                "note": (
                    "Only one valid observation: no change over time can be "
                    "computed. At least 2 observations are required for a "
                    "comparison and 3 for a trend."
                ),
            }
        )
        return stats

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

    if len(values) < MIN_OBSERVATIONS_FOR_TREND:
        note = (
            (note + " " if note else "")
            + f"Only {len(values)} valid observation(s): this is a two-point "
            "comparison, not a fitted trend. At least "
            f"{MIN_OBSERVATIONS_FOR_TREND} are required for trend inference."
        )

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


def apply_aoi(
    region: dict[str, Any],
    aoi: dict[str, Any] | None,
    aoi_crs: str | None = None,
) -> tuple[dict[str, Any] | None, list[str]]:
    """Intersect the requested region with an optional AOI.

    Returns ``(effective_region_or_None, warnings)``. ``effective_region`` is
    ``None`` when no AOI was requested, meaning the analysis is region-scoped.
    An AOI that does not intersect the region is an error, not an empty series:
    silently analysing the whole region instead would return numbers for ground
    the caller did not ask about.
    """
    if aoi is None:
        return None, []
    if not isinstance(aoi, dict):
        raise TrendValidationError("aoi must be a GeoJSON geometry object.")
    gtype = aoi.get("type")
    if gtype not in ("Polygon", "MultiPolygon"):
        raise TrendValidationError(
            f"Unsupported aoi type '{gtype}'. /trend supports a GeoJSON "
            "Polygon or MultiPolygon geometry."
        )
    try:
        aoi_geom = shape(aoi)
    except Exception as exc:
        raise TrendValidationError(f"Invalid aoi GeoJSON geometry: {exc}") from exc
    if aoi_geom.is_empty or not aoi_geom.is_valid:
        raise TrendValidationError("aoi geometry is empty or invalid.")

    declared = aoi_crs or (aoi.get("crs") if isinstance(aoi.get("crs"), str) else None)
    if declared is None and isinstance(aoi.get("crs"), dict):
        name = (aoi["crs"].get("properties") or {}).get("name")
        declared = name if isinstance(name, str) else None
    aoi_geom, _ = _to_wgs84(aoi_geom, declared)

    region_geom = shape(region)
    region_geom, _ = _to_wgs84(
        region_geom,
        region.get("crs") if isinstance(region.get("crs"), (str, dict)) else None,
    )

    if not aoi_geom.intersects(region_geom):
        raise TrendValidationError(
            "The AOI does not intersect the requested region; there is no area to "
            "analyse. Check that both geometries refer to the same place and CRS."
        )
    clipped = region_geom.intersection(aoi_geom)
    if clipped.is_empty or clipped.area <= 0:
        raise TrendValidationError(
            "The AOI only touches the requested region boundary, leaving no area "
            "to analyse."
        )

    warnings: list[str] = []
    if declared is not None:
        warnings.append(
            f"AOI was supplied in {declared} and reprojected to {NATIVE_CRS}; "
            "the applied AOI bounds are in " + NATIVE_CRS + "."
        )
    return _geometry_to_geojson(clipped), warnings


def _geometry_to_gs84_meta(geom) -> dict[str, Any]:
    """Bounds + CRS block for a WGS84 geometry, matching ``region_meta``."""
    minx, miny, maxx, maxy = geom.bounds
    return {
        "bounds": {
            "west": float(minx), "south": float(miny),
            "east": float(maxx), "north": float(maxy),
        },
        "crs": NATIVE_CRS,
    }


def _geometry_to_geojson(geom) -> dict[str, Any]:
    """Serialise a shapely geometry back to bare GeoJSON for the provider."""
    return mapping(geom)


def compute_trend(
    provider,
    *,
    metric: str,
    region: dict[str, Any],
    start_date: str,
    end_date: str,
    interval: str = "monthly",
    aoi: dict[str, Any] | None = None,
    aoi_crs: str | None = None,
) -> dict[str, Any]:
    """Run the full trend pipeline against a given provider."""
    metric_p = (metric or "").lower()
    validate_metric(metric_p)
    if interval not in ("monthly", "yearly"):
        raise TrendValidationError(
            f"Unsupported interval '{interval}'. Supported: monthly, yearly."
        )
    region_meta, region_warnings = validate_region(region)

    # The AOI narrows the area actually queried. It is resolved before the
    # provider call so the provider never sees ground outside the applied scope.
    effective_region, aoi_warnings = apply_aoi(region, aoi, aoi_crs)
    aoi_scope = _aoi_scope_meta(region, region_meta, effective_region)

    query_region = effective_region if effective_region is not None else region

    start_dt, end_dt, date_warnings = parse_date_range(start_date, end_date)
    start_iso, end_iso = start_dt.isoformat(), end_dt.isoformat()

    provider_payload = provider.compute_trend(
        metric_p, query_region, start_iso, end_iso, interval=interval
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
        + aoi_warnings
        + provider_warnings
        + series_warnings
    )
    source = provider_payload.get("source", "unknown")

    if not any(s.get("value") is not None for s in series):
        if aoi_scope.get("aoiApplied"):
            raise TrendComputationError(
                "No valid observations were returned for the requested AOI/region, "
                "date range and metric. Nothing can be quantified."
            )
        raise TrendComputationError(
            "No valid observations were returned for the requested region/date "
            "range/metric. Nothing can be quantified."
        )

    result = {
        "metric": metric_p,
        "region": region_meta,
        # The geometry actually analysed. Equal to `region` when no AOI was
        # requested, so a consumer can always read the analysed scope here.
        "analyzedRegion": (
            {**region_meta, **_geometry_to_gs84_meta(shape(query_region))}
            if effective_region is None
            else {
                **region_meta,
                **_geometry_to_gs84_meta(shape(query_region)),
                "type": effective_region.get("type", region_meta.get("type")),
            }
        ),
        "aoiScope": aoi_scope,
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


def _aoi_scope_meta(
    region: dict[str, Any],
    region_meta: dict[str, Any],
    effective_region: dict[str, Any] | None,
) -> dict[str, Any]:
    """Describe the scope the series was actually computed over.

    Only fields that are genuinely known are populated; this tool never opens a
    raster, so there is no pixel coverage or georeference to report and none is
    invented.
    """
    requested = {
        "bounds": region_meta.get("bounds"),
        "crs": region_meta.get("crs"),
    }
    if effective_region is None:
        return {
            "aoiApplied": False,
            "aoiScope": "region",
            "aoiStatus": "not_requested",
            "crs": region_meta.get("crs"),
            "requestedBounds": requested["bounds"],
            "analyzedBounds": requested["bounds"],
            "reason": "No AOI was supplied; the full requested region was analysed.",
        }

    analyzed = _geometry_to_gs84_meta(shape(effective_region))
    return {
        "aoiApplied": True,
        "aoiScope": "aoi",
        "aoiStatus": "applied",
        "crs": analyzed["crs"],
        "requestedBounds": requested["bounds"],
        "analyzedBounds": analyzed["bounds"],
        "aoiBounds": analyzed["bounds"],
        "regionBounds": requested["bounds"],
        "reason": (
            "The series was computed over the AOI clipped to the requested "
            "region. Analyzed bounds differ from the requested region."
        ),
    }


def trend_confidence(result: dict[str, Any]) -> float:
    """Deterministic confidence (reliability, not statistical significance).

    1.0 if all inputs valid, no warnings, real (non-mock) observations exist and
    there are enough of them to support a trend.
    0.8 if any warnings, missing periods, mock/fixture source, or too few
    observations to infer a trend from (the value can only be compared).
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
    # Below MIN_OBSERVATIONS_FOR_TREND this is a comparison, not a trend, so it
    # cannot carry the same confidence as a fitted trend even when every
    # observation is real and complete.
    if not trend.get("sufficient_for_trend", True):
        return 0.8
    return 1.0
