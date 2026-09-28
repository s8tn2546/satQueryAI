"""STAC scene search + AOI-only acquisition orchestration.

This module owns the deterministic parts of ``/stac/search`` and
``/stac/ingest``:

- AOI validation (reuses :mod:`app.tools.roi_crop` so semantics match every
  other analysis tool) and ISO date-window validation for search.
- directing every request through a :class:`SatelliteProvider` (real STAC,
  explicit offline fallback, or clearly-labelled test fixtures).
- writing an acquired AOI window to a local analysis GeoTIFF (native scene CRS
  / geotransform, band descriptions set to the real asset names) and a derived
  RGB preview PNG.
- running the existing validation pipeline on the analysis raster.
- computing the deterministic dedupe key used by the backend tile store.

Honesty guarantees (never bent)
-------------------------------
* No synthetic scene is ever labelled as real data: fixture results carry
  ``mock: true`` plus a stated reason.
* The AOI window is a *windowed* read (COG range requests when the provider is
  real); it is reported as ``scope: cog-window-read``, never as a polygon mask.
* If the scene CRS cannot be established, or a requested band is absent, the
  operation fails rather than guessing.
* Reprojection is NOT performed: the analysis raster keeps the scene's native
  CRS. Requesting a different ``target_crs`` than the scene native CRS is an
  explicit, documented failure.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any

import numpy as np
import rasterio

from app.geospatial.crs import bounds_to_wgs84, crs_to_string, parse_crs
from app.geospatial.validation import run_validation
from app.services.satellite_provider import (
    SatelliteProvider,
    SatelliteProviderError,
    get_provider,
    provider_labels,
    resolve_collection,
)
from app.tools.roi_crop import AoiCrsError, RoiCropError, parse_aoi
from shapely.geometry import mapping

logger = logging.getLogger(__name__)

# Documented upper bound on a requested search window (years), consistent with
# the /fetch-imagery span cap so STAC queries stay reasonable.
MAX_SEARCH_WINDOW_YEARS = 30

# Default band roles acquired when the caller does not specify any.
DEFAULT_BANDS = ["blue", "green", "red", "nir"]

# Channel order and naming used in the RGB preview.
PREVIEW_CHANNELS = ("red", "green", "blue")


class StacToolError(Exception):
    """Base error for STAC tool failures."""


class StacValidationError(StacToolError):
    """Raised when a search/ingest request is structurally invalid."""


class ReprojectionUnsupportedError(StacToolError):
    """Raised when a caller requests a target CRS the tool cannot honour."""


ACQUISITION_DIR_DEFAULT = "acquisitions"


def acquisition_dir() -> Path:
    """Directory where acquired analysis rasters/previews are written."""
    configured = os.environ.get("ACQUISITION_DIR", "").strip()
    base = Path(configured) if configured else Path.cwd() / ACQUISITION_DIR_DEFAULT
    base.mkdir(parents=True, exist_ok=True)
    return base


# --------------------------------------------------------------------------- #
# Input validation                                                             #
# --------------------------------------------------------------------------- #


def _parse_iso(value: str | None, label: str) -> _dt.date | None:
    if value is None or not str(value).strip():
        return None
    try:
        return _dt.date.fromisoformat(str(value).strip())
    except ValueError as exc:
        raise StacValidationError(
            f"Invalid {label} format (expected ISO YYYY-MM-DD): {exc}"
        ) from exc


def _aoi_for_search(aoi: Any, aoi_crs: Any = None) -> dict[str, Any]:
    """Validate the AOI and its WGS84 geometry for STAC search."""
    try:
        parsed = parse_aoi(aoi, aoi_crs)
    except (AoiCrsError, RoiCropError) as exc:
        raise StacValidationError(str(exc)) from exc
    geometry = parsed.geometry
    if parsed.crs_label != "EPSG:4326":
        from app.tools.roi_crop import transform_aoi_to_crs

        projected = transform_aoi_to_crs(
            parsed.shapely, parsed.crs, parse_crs("EPSG:4326")
        )
        geometry = mapping(projected)
    return geometry


def _geom_type_from(geometry: dict[str, Any]) -> str:
    return geometry.get("type", "Polygon")


def _coordinates(geometry: dict[str, Any]) -> Any:
    return geometry.get("coordinates")


def _geom_type_from(geometry: dict[str, Any]) -> str:
    return geometry.get("type", "Polygon")


def _coordinates(geometry: dict[str, Any]) -> Any:
    return geometry.get("coordinates")


def _geometry_from_shapely(geom: Any) -> dict[str, Any]:
    from shapely.geometry import mapping
    return mapping(geom)


def validate_date_window(
    start: str | None,
    end: str | None,
    *,
    require_both: bool = True,
    today: _dt.date | None = None,
) -> tuple[str, str, list[str]]:
    """Validate a search date window; returns (start_iso, end_iso, warnings)."""
    warnings: list[str] = []
    now = today or _dt.date.today()

    s = _parse_iso(start, "start")
    e = _parse_iso(end, "end")
    if require_both and (s is None or e is None):
        missing = "start" if s is None else "end"
        raise StacValidationError(
            f"dateRange.{missing} is required (ISO YYYY-MM-DD) for /stac/search."
        )
    if s is not None and e is not None:
        if s >= e:
            raise StacValidationError(
                "dateRange.start must be earlier than dateRange.end (start < end)."
            )
        if e > now:
            raise StacValidationError(
                f"dateRange.end ({e.isoformat()}) is in the future; /stac/search "
                "never queries future acquisitions."
            )
        span_days = (e - s).days
        if span_days > MAX_SEARCH_WINDOW_YEARS * 365:
            raise StacValidationError(
                f"Requested window (~{span_days} days) exceeds the supported "
                f"maximum of {MAX_SEARCH_WINDOW_YEARS} years."
            )
        return s.isoformat(), e.isoformat(), warnings

    # A single date means a single-day window (start == end coverage intended).
    only = s or e
    if only is None:  # pragma: no cover - require_both normally blocks this
        raise StacValidationError("A date range is required.")
    return only.isoformat(), only.isoformat(), warnings


def validate_cloud_max(cloud_max: float | None) -> float | None:
    if cloud_max is None:
        return None
    try:
        value = float(cloud_max)
    except (TypeError, ValueError) as exc:
        raise StacValidationError(
            f"cloudMax must be a number 0-100; got {cloud_max!r}."
        ) from exc
    if not (0 <= value <= 100):
        raise StacValidationError(
            f"cloudMax must be within 0-100; got {value}."
        )
    return value


def normalize_limit(limit: int | None) -> int:
    if limit is None:
        return 10
    try:
        value = int(limit)
    except (TypeError, ValueError) as exc:
        raise StacValidationError(f"limit must be an integer; got {limit!r}.") from exc
    if not (1 <= value <= 100):
        raise StacValidationError(f"limit must be within 1-100; got {value}.")
    return value


# --------------------------------------------------------------------------- #
# Search                                                                       #
# --------------------------------------------------------------------------- #


def search_scenes(
    provider: SatelliteProvider,
    *,
    collection: str | None = None,
    sensor: str | None = None,
    aoi: Any,
    aoi_crs: str | None = None,
    start: str | None = None,
    end: str | None = None,
    cloud_max: float | None = None,
    limit: int | None = None,
    today: _dt.date | None = None,
) -> dict[str, Any]:
    """Run a scene search against a provider and return normalized results."""
    cfg = resolve_collection(sensor, collection)
    geometry = _aoi_for_search(aoi, aoi_crs)
    start_iso, end_iso, date_warnings = validate_date_window(
        start, end, today=today
    )
    cloud = validate_cloud_max(cloud_max)
    lim = normalize_limit(limit)

    scenes = provider.search_scenes(
        collection=cfg["collection"],
        aoi=geometry,
        start=start_iso,
        end=end_iso,
        cloud_max=cloud,
        limit=lim,
    )

    warnings = list(date_warnings)
    if not scenes:
        warnings.append(
            "No scenes matched the request. This is a valid empty result, not "
            "a provider failure."
        )
    mock = False
    reason = None
    if provider.is_fixture:
        mock = True
        reason = getattr(provider, "FIXTURE_REASON", None)
        warnings.insert(0, reason or "Fixture data — NOT real satellite observations.")
    if mock and warnings and warnings[0] == reason:
        pass
    return {
        "source": provider.name,
        "provider": provider.name,
        "collection": cfg["collection"],
        "collectionName": cfg["name"],
        "resolution": cfg["resolution"],
        "query": {
            "sensor": sensor,
            "collection": collection or cfg["collection"],
            "aoi": geometry,
            "aoiCrs": "EPSG:4326",
            "dateRange": {"start": start_iso, "end": end_iso},
            "cloudMax": cloud,
            "limit": lim,
        },
        "scenes": [scene.summary() for scene in scenes],
        "count": len(scenes),
        "mock": mock,
        "reason": reason,
        "warnings": warnings,
        "labels": provider_labels(),
    }


# --------------------------------------------------------------------------- #
# Ingest                                                                       #
# --------------------------------------------------------------------------- #


def resolve_roles(cfg: dict[str, Any], bands: list[str] | None) -> list[str]:
    """Map requested band names/roles onto validated internal roles."""
    asset_to_role = {asset: role for role, asset in cfg["band_roles"].items()}
    roles: list[str] = []
    for band in (bands or DEFAULT_BANDS):
        role = band if band in cfg["band_roles"] else asset_to_role.get(band)
        if role is None:
            raise StacValidationError(
                f"Band '{band}' is not available in collection "
                f"'{cfg['collection']}'. Supported roles: "
                f"{', '.join(sorted(cfg['band_roles']))}."
            )
        if role not in roles:
            roles.append(role)
    return roles


def canonical_aoi_json(geometry: dict[str, Any]) -> str:
    """Deterministic canonical JSON for an AOI (coordinates rounded to 6dp)."""
    def _round(c: Any) -> Any:
        if isinstance(c, list):
            if c and all(isinstance(v, (int, float)) for v in c):
                return [round(float(v), 6) for v in c]
            return [_round(v) for v in c]
        return c

    canonical = {
        "type": geometry.get("type", "Polygon"),
        "coordinates": _round(geometry.get("coordinates", [])),
    }
    return json.dumps(canonical, sort_keys=True, separators=(",", ":"))


def build_dedupe_key(
    provider: SatelliteProvider,
    collection: str,
    scene_id: str,
    aoi_canonical: str,
    roles: list[str],
    target_crs: str,
) -> str:
    """Deterministic tile dedupe key for the backend tile store."""
    return (
        f"stac:{provider.name}:{collection}:{scene_id}:"
        f"{aoi_canonical}:{','.join(sorted(roles))}:{target_crs}"
    )


def write_analysis_raster(
    window: Any,
    roles: list[str],
    out_path: str | Path,
) -> Path:
    """Write the acquired AOI window as a georeferenced analysis GeoTIFF.

    Band order follows the requested role order; band descriptions are set to
    the real provider asset names so downstream band resolution works exactly
    as it would on a native file. No reprojection is performed: the geotransform
    and CRS are the scene's own.
    """
    out = Path(out_path)
    arrays = [np.asarray(band.data) for band in window.bands]
    if not arrays:
        raise StacToolError("Acquisition window contains no band data.")
    dtype = np.result_type(*[a.dtype for a in arrays])
    height, width = int(arrays[0].shape[0]), int(arrays[0].shape[1])
    stack = np.stack([a.astype(dtype) for a in arrays])

    with rasterio.open(
        out,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=int(stack.shape[0]),
        dtype=str(dtype),
        nodata=window.nodata,
        crs=window.crs if window.crs else None,
        transform=window.transform,
    ) as dst:
        for index in range(stack.shape[0]):
            dst.write(stack[index], index + 1)
        for index, band in enumerate(window.bands, start=1):
            dst.set_band_description(index, band.asset)
    return out


def _band_roles_by_asset(window: Any, cfg: dict[str, Any]) -> dict[str, str]:
    asset_to_role = {asset: role for role, asset in cfg["band_roles"].items()}
    roles: dict[str, str] = {}
    for band in window.bands:
        role = asset_to_role.get(band.asset) or band.eo_common_name
        if role in cfg["band_roles"]:
            roles[role] = band.asset
    return roles


def write_rgb_preview(
    window: Any,
    cfg: dict[str, Any],
    out_path: str | Path,
) -> dict[str, Any] | None:
    """Derive an RGB PNG preview when blue/green/red were acquired.

    Returns ``None`` (never fabricated) when the requested bands lack any of
    the three preview channels.
    """
    by_asset = {band.asset: np.asarray(band.data) for band in window.bands}
    nodata = window.nodata
    channels = {}
    for role in PREVIEW_CHANNELS:
        asset_name = cfg["band_roles"].get(role)
        data = by_asset.get(asset_name)
        if data is None:
            return None
        mask = (data == nodata) if nodata is not None else None
        channels[role] = np.ma.masked_array(data, mask=mask)

    rgb = np.ma.stack([channels[c] for c in PREVIEW_CHANNELS])
    stretched = np.ma.empty_like(rgb, dtype=np.uint8)
    for index in range(rgb.shape[0]):
        band = rgb[index].astype(np.float64)
        lo, hi = np.percentile(band.compressed(), (2, 98)) if band.compressed().size else (0.0, 1.0)
        if hi <= lo:
            hi = lo + 1.0
        scaled = np.clip((band - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)
        stretched[index] = scaled

    from PIL import Image

    image = Image.fromarray(np.asarray(stretched.transpose(1, 2, 0)), mode="RGB")
    image.save(out_path, format="PNG")
    return {
        "filePath": str(Path(out_path)),
        "channels": list(PREVIEW_CHANNELS),
        "stretch": "percentile-2-98",
        "width": int(stretched.shape[2]),
        "height": int(stretched.shape[1]),
    }


def validation_summary(result: Any) -> dict[str, Any]:
    wgs = None
    if result.wgs84_bounds is not None:
        wgs = {
            "west": float(result.wgs84_bounds.west),
            "south": float(result.wgs84_bounds.south),
            "east": float(result.wgs84_bounds.east),
            "north": float(result.wgs84_bounds.north),
        }
    res = None
    if result.resolution is not None:
        res = {"x": float(result.resolution.x), "y": float(result.resolution.y)}
    return {
        "valid": bool(result.valid),
        "status": result.validation_status.value,
        "integrity": result.integrity,
        "isGeoreferenced": bool(result.is_georeferenced),
        "modality": (
            result.modality.value if result.modality is not None else None
        ),
        "crs": result.crs,
        "width": int(result.width),
        "height": int(result.height),
        "bandCount": int(result.band_count),
        "dtype": result.dtype,
        "resolution": res,
        "wgs84Bounds": wgs,
        "warnings": list(result.warnings),
        "errors": list(result.errors),
    }


def ingest_scene(
    provider: SatelliteProvider,
    *,
    collection: str,
    scene_id: str,
    aoi: Any,
    aoi_crs: str | None = None,
    bands: list[str] | None = None,
    target_crs: str | None = None,
    out_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Acquire the requested AOI of a scene, persist analysis + preview."""
    cfg = resolve_collection(None, collection)
    try:
        parsed = parse_aoi(aoi, aoi_crs)
    except (AoiCrsError, RoiCropError) as exc:
        raise StacValidationError(str(exc)) from exc
    roles = resolve_roles(cfg, bands)

    scene = provider.get_scene_metadata(collection=cfg["collection"], scene_id=scene_id)
    if scene.collection != cfg["collection"]:
        raise StacToolError(
            f"Scene '{scene_id}' belongs to collection '{scene.collection}', "
            f"not '{cfg['collection']}'. No acquisition performed."
        )

    window = provider.fetch_scene_aoi(
        collection=cfg["collection"],
        scene_id=scene_id,
        aoi=parsed.geometry,
        aoi_crs=parsed.crs,
        bands=roles,
    )

    if target_crs:
        target = parse_crs(target_crs)
        native = parse_crs(window.crs)
        if target is None:
            raise StacValidationError(
                f"targetCrs '{target_crs}' could not be parsed."
            )
        if native is None or target.to_epsg() != native.to_epsg():
            raise ReprojectionUnsupportedError(
                f"targetCrs '{target_crs}' differs from the scene's native CRS "
                f"({window.crs}). Reprojection is not supported yet; the "
                f"analysis raster keeps the scene's native CRS. Re-request with "
                f"target_crs={window.crs} or omit it."
            )

    out = Path(out_dir) if out_dir else acquisition_dir()
    out.mkdir(parents=True, exist_ok=True)
    tag = ",".join(roles)
    stem = f"{scene_id}_{tag}_{window.width}x{window.height}"
    analysis_path = out / f"{stem}.tif"
    analysis_path = write_analysis_raster(window, roles, analysis_path)

    preview = None
    preview_path = out / f"{stem}_preview.png"
    preview = write_rgb_preview(window, cfg, preview_path)

    result = run_validation(analysis_path, modality_hint="optical")

    native = parse_crs(window.crs)
    wgs84_bounds = None
    if native is not None and window.native_crs_bounds:
        wgs84_bounds = bounds_to_wgs84(window.native_crs_bounds, native)

    source_crs = scene.crs or window.crs
    if source_crs is None:
        raise StacToolError(
            f"Scene '{scene_id}' declares no CRS; refusing to record a CRS."
        )

    dedupe_key = build_dedupe_key(
        provider,
        cfg["collection"],
        scene_id,
        canonical_aoi_json(parsed.geometry),
        roles,
        source_crs,
    )

    warnings = list(parsed.warnings) + list(window.warnings)
    mock = bool(provider.is_fixture)
    reason = getattr(provider, "FIXTURE_REASON", None) if mock else None
    if mock and reason and reason not in warnings:
        warnings.insert(0, reason)

    res_x = abs(float(window.transform.a)) if window.transform else None
    res_y = abs(float(window.transform.e)) if window.transform else None

    return {
        "source": provider.name,
        "provider": provider.name,
        "collection": cfg["collection"],
        "collectionName": cfg["name"],
        "sceneId": scene_id,
        "scene": scene.summary(),
        "aoi": {
            "geometry": parsed.geometry,
            "crs": parsed.crs_label,
            "crsSource": parsed.crs_source,
            "bounds": parsed.bounds,
            "warnings": list(parsed.warnings),
        },
        "analysisRaster": str(analysis_path),
        "analysis": {
            "roles": roles,
            "bands": [band.asset for band in window.bands],
            "dtype": str(np.result_type(*[np.asarray(b.data).dtype for b in window.bands])),
            "width": window.width,
            "height": window.height,
            "crs": window.crs,
            "resolution": (
                {"x": float(res_x), "y": float(res_y)}
                if res_x is not None
                else None
            ),
            "nativeBounds": window.native_crs_bounds,
            "wgs84Bounds": wgs84_bounds,
            "nodata": window.nodata,
            "method": window.method,
            "scope": "cog-window-read",
            "bandDescriptions": [band.asset for band in window.bands],
        },
        "preview": preview,
        "validation": validation_summary(result),
        "dedupeKey": dedupe_key,
        "mock": mock,
        "reason": reason,
        "warnings": warnings,
        "labels": provider_labels(),
    }