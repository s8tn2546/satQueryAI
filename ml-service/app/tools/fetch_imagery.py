"""Region-based imagery acquisition core (network-free).

This module owns the deterministic parts of ``/fetch-imagery``:

- bounding-box validation (GeoJSON Polygon / MultiPolygon, lon/lat ranges, non-zero area)
- date-window validation (ISO dates, start < end, no future dates, span cap, defaults)
- orchestrating a GEE provider's ``fetch_pair`` into a normalised acquisition result
- passing any actually-downloaded raster through the existing validation pipeline
- deterministic confidence (reliability, not statistical significance)

It deliberately does NOT call Google Earth Engine directly. It consumes a provider
(``app/services/gee_client.py``) that returns a normalised optical + SAR acquisition
pair. Any image that was truly downloaded (real mode) has a ``file_path`` and is
validated here with ``app.geospatial.validation.run_validation``.

This is acquisition/remote-sensing work only — no semantic interpretation
(flood/deforestation/etc.) is drawn; that is Member 5's job.
"""

from __future__ import annotations

import datetime as _dt
from pathlib import Path
from typing import Any

from shapely.geometry import shape

from app.geospatial.validation import run_validation
from app.services.gee_client import DEFAULT_FETCH_DAYS

# Documented upper bound on a requested search window (years) — consistent with the
# span cap used elsewhere in this project (trend) to keep GEE queries reasonable.
MAX_FETCH_WINDOW_YEARS = 30

# Sentinel-2 / Sentinel-1 supported sources (never silently substituted).
SUPPORTED_SOURCES = {"sentinel-1", "sentinel-2"}
SUPPORTED_MODALITIES = {"optical", "sar"}


class FetchImageryError(Exception):
    """Base error for imagery-acquisition failures."""


class FetchValidationError(FetchImageryError):
    """Raised when the bounding box or dates are invalid."""


class FetchNoImageError(FetchImageryError):
    """Raised when no usable imagery could be acquired."""


# --------------------------------------------------------------------------- #
# Bounding-box validation                                                      #
# --------------------------------------------------------------------------- #


def validate_bbox(geojson: Any) -> dict[str, Any]:
    """Validate a GeoJSON Polygon/MultiPolygon bounding box.

    Returns a metadata dict on success; raises FetchValidationError (never repairs
    the input) on malformed/empty/invalid/zero-area/out-of-range geometry.
    """
    if not isinstance(geojson, dict):
        raise FetchValidationError("bounding_box must be a GeoJSON geometry object.")

    gtype = geojson.get("type")
    if gtype not in ("Polygon", "MultiPolygon"):
        raise FetchValidationError(
            f"Unsupported bounding_box type '{gtype}'. /fetch-imagery supports a "
            "GeoJSON Polygon or MultiPolygon."
        )

    try:
        geom = shape(geojson)
    except Exception as exc:
        raise FetchValidationError(f"Invalid GeoJSON geometry: {exc}") from exc

    if geom.is_empty:
        raise FetchValidationError("bounding_box geometry is empty.")
    if not geom.is_valid:
        raise FetchValidationError(
            "bounding_box geometry is invalid (shapely reports is_valid=False)."
        )

    minx, miny, maxx, maxy = geom.bounds
    for label, mn, mx in (("longitude", minx, maxx), ("latitude", miny, maxy)):
        if mn < -180 or mx > 180:
            raise FetchValidationError(
                f"bounding_box {label} out of range [-180, 180]: [{mn}, {mx}]."
            )
    for label, mn, mx in (("latitude", miny, maxy),):
        if mn < -90 or mx > 90:
            raise FetchValidationError(
                f"bounding_box {label} out of range [-90, 90]: [{mn}, {mx}]."
            )

    area_deg2 = abs(geom.area)
    if area_deg2 <= 0:
        raise FetchValidationError("bounding_box geometry has zero area.")

    return {
        "type": gtype,
        "bounds": {
            "west": float(minx), "south": float(miny),
            "east": float(maxx), "north": float(maxy),
        },
        "centroid": {"lat": float(geom.centroid.y), "lon": float(geom.centroid.x)},
        "area_deg2": float(area_deg2),
    }


# --------------------------------------------------------------------------- #
# Date-window validation                                                       #
# --------------------------------------------------------------------------- #


def parse_date_window(
    start_date: str | None,
    end_date: str | None,
    preferred_date: str | None = None,
    today: _dt.date | None = None,
) -> tuple[str, str, str | None, list[str]]:
    """Validate/normalise the (optional) search window and preferred date.

    Returns (start_iso, end_iso, preferred_iso, warnings). When neither start nor end
    is given, defaults to the documented "reasonable recent" window of
    DEFAULT_FETCH_DAYS ending today. Raises FetchValidationError on invalid dates.
    """
    warnings: list[str] = []
    now = today or _dt.date.today()

    def _parse(label: str, val: str | None) -> _dt.date | None:
        if val is None or (isinstance(val, str) and not val.strip()):
            return None
        try:
            return _dt.date.fromisoformat(str(val))
        except ValueError as exc:
            raise FetchValidationError(
                f"Invalid {label} format (expected ISO YYYY-MM-DD): {exc}"
            ) from exc

    s = _parse("start_date", start_date)
    e = _parse("end_date", end_date)

    if s is not None and e is None:
        e = now
        if e <= s:
            raise FetchValidationError(
                "start_date must be earlier than end_date (start < end)."
            )
    elif e is not None and s is None:
        s = e - _dt.timedelta(days=DEFAULT_FETCH_DAYS)
    elif s is None and e is None:
        e = now
        s = e - _dt.timedelta(days=DEFAULT_FETCH_DAYS)

    assert s is not None and e is not None  # guaranteed above

    if s >= e:
        raise FetchValidationError(
            "start_date must be earlier than end_date (start < end)."
        )
    if e > now:
        raise FetchValidationError(
            f"end_date ({end_date or e.isoformat()}) is in the future; "
            "/fetch-imagery does not query future dates."
        )
    span_days = (e - s).days
    if span_days > MAX_FETCH_WINDOW_YEARS * 365:
        raise FetchValidationError(
            f"Requested window (~{span_days} days) exceeds the supported maximum "
            f"of {MAX_FETCH_WINDOW_YEARS} years."
        )

    pref = _parse("preferred_date", preferred_date) if preferred_date else None
    if pref is not None and not (s <= pref <= e):
        warnings.append(
            "preferred_date falls outside the search window and will be treated as "
            "a hint only."
        )

    return (
        s.isoformat(),
        e.isoformat(),
        pref.isoformat() if pref else None,
        warnings,
    )


# --------------------------------------------------------------------------- #
# Validation-pipeline integration for downloaded rasters                       #
# --------------------------------------------------------------------------- #


def _validate_downloaded_image(file_path: str | None, modality: str) -> dict[str, Any]:
    """Run a downloaded raster through the existing validation pipeline.

    Returns a small dict attaching ``validated`` (bool) and a short validation
    summary. Images without a real file (mock) are reported as not validated (and
    never fabricated).
    """
    if not file_path or not Path(file_path).exists():
        return {"validated": False, "validation_status": "not-downloaded"}
    result = run_validation(file_path, modality_hint=modality)
    return {
        "validated": result.valid,
        "validation_status": result.validation_status.value,
        "validation_warnings": result.warnings,
        "validation_errors": result.errors,
        "resolution": (
            {"x": result.resolution.x, "y": result.resolution.y}
            if result.resolution is not None
            else None
        ),
        "crs": result.crs,
        "offered_wgs84_bounds": (
            {
                "west": result.wgs84_bounds.west,
                "south": result.wgs84_bounds.south,
                "east": result.wgs84_bounds.east,
                "north": result.wgs84_bounds.north,
            }
            if result.wgs84_bounds is not None
            else None
        ),
    }


def _image_summary(image: dict[str, Any]) -> dict[str, Any]:
    """Build the Section 8-style per-image output entry from provider metadata."""
    summary = {
        "modality": image.get("modality"),
        "source": image.get("source"),
        "satellite": image.get("satellite"),
        "collection": image.get("collection"),
        "filePath": image.get("file_path"),
        "downloaded": bool(image.get("downloaded")),
        "captureDate": image.get("capture_date"),
        "boundingBox": image.get("bounding_box"),
        "crs": image.get("crs"),
        "resolution": image.get("resolution"),
        "bands": image.get("bands") or [],
        "product_id": image.get("product_id"),
    }
    if image.get("modality") == "optical":
        summary["cloudCover"] = image.get("cloud_cover")
        summary["quality_mask"] = image.get("quality_mask")
    if image.get("modality") == "sar":
        summary["polarization"] = image.get("polarization") or []
        summary["orbit"] = image.get("orbit")
        summary["sar_processing"] = image.get("sar_processing")
    return summary


# --------------------------------------------------------------------------- #
# Orchestrator                                                                #
# --------------------------------------------------------------------------- #


def fetch_imagery(
    provider,
    *,
    bounding_box: dict[str, Any],
    start_date: str | None = None,
    end_date: str | None = None,
    preferred_date: str | None = None,
) -> dict[str, Any]:
    """Run the imagery-acquisition pipeline against a given provider."""
    bbox_meta = validate_bbox(bounding_box)
    start_iso, end_iso, pref_iso, date_warnings = parse_date_window(
        start_date, end_date, preferred_date
    )

    provider_payload = provider.fetch_pair(
        bounding_box, start_iso, end_iso, preferred_date=pref_iso
    )
    provider_warnings = list(provider_payload.get("provider_warnings", []))
    source = provider_payload.get("source", "unknown")

    images = []
    for key in ("optical", "sar"):
        raw = provider_payload.get(key)
        if not raw:
            continue
        modality = raw.get("modality")
        image_source = raw.get("source")
        if modality not in SUPPORTED_MODALITIES:
            raise FetchValidationError(
                f"Provider returned an unsupported modality '{modality}'. "
                f"Supported: {sorted(SUPPORTED_MODALITIES)}."
            )
        if image_source not in SUPPORTED_SOURCES:
            raise FetchValidationError(
                f"Provider returned an unsupported source '{image_source}'. "
                f"Supported: {sorted(SUPPORTED_SOURCES)}."
            )
        summary = _image_summary(raw)
        summary.update(
            _validate_downloaded_image(raw.get("file_path"), raw.get("modality"))
        )
        images.append(summary)

    if not images:
        raise FetchNoImageError(
            "No imagery acquisition could be produced for the requested region/window."
        )

    date_gap_days = provider_payload.get("date_gap_days")
    date_gap_days = int(date_gap_days) if date_gap_days is not None else None

    warnings = date_warnings + provider_warnings
    if date_gap_days is not None and date_gap_days > 5:
        warnings.append(
            f"Optical/SAR acquisition date gap is {date_gap_days} days "
            "(> 5 days); the pair's temporal coherence is reduced."
        )
    # The mock provider already labels its own output via provider_warnings; the
    # source is also surfaced in metadata.data_source and per-image fields.
    if source != "gee" and not any("Mock/fixture" in w for w in warnings):
        warnings.insert(
            0, "Mock/fixture data — NOT real GEE satellite observations."
        )

    return {
        "source": source,
        "bounding_box": bbox_meta,
        "date_range": {"start": start_iso, "end": end_iso},
        "images": images,
        "date_gap_days": date_gap_days,
        "warnings": warnings,
    }


def fetch_status(result: dict[str, Any]) -> str:
    """Deterministic top-level status: 'success' | 'partial' | 'failed'."""
    source = result.get("source")
    images = result.get("images") or []
    if not images:
        return "failed"
    if source == "mock":
        # A labelled mock pair is a complete, usable (test) result.
        return "success"
    if len(images) < 2:
        return "partial"
    valid = [i for i in images if i.get("validated")]
    if not valid:
        return "partial" if images else "failed"
    if len(valid) == len(images):
        return "success"
    return "partial"


def fetch_confidence(result: dict[str, Any]) -> float:
    """Deterministic confidence (reliability, not statistical significance).

    - mock/fixture (explicitly labelled) → 0.7
    - real, complete pair, both validated, no warnings → 1.0
    - real, warnings or date gap or partial validation → 0.8
    - real, only one of the pair acquired → 0.5
    - no images → 0.0 (reached externally on failure)
    """
    source = result.get("source")
    images = result.get("images") or []
    warnings = result.get("warnings") or []

    if source != "gee":
        return 0.7
    if not images:
        return 0.0
    if len(images) < 2:
        return 0.5
    if warnings:
        return 0.8
    if not all(i.get("validated") for i in images):
        return 0.8
    return 1.0
