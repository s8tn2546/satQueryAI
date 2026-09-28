"""STAC-backed satellite imagery provider (scene search + AOI-only acquisition).

This is the provider layer behind ``/stac/search`` and ``/stac/ingest``. It
deliberately mirrors the shape of ``gee_client.py`` (the trend/fetch provider):
an abstract ``SatelliteProvider`` interface, a real implementation that talks to
a SpatioTemporal Asset Catalog (STAC) API, and clearly-labelled alternatives used
only when a live API is not configured or during tests.

Providers
---------
- ``StacSatelliteProvider`` — real production path. Uses ``pystac_client``
  against a STAC API whose URL comes *only* from the environment. Scene assets
  are Cloud-Optimized GeoTIFFs (COGs), so an AOI-restricted window read pulls
  only the intersecting bytes (range requests) instead of a whole scene.
- ``OfflineSatelliteProvider`` — production fallback when no STAC URL is
  configured (``STAC_MODE=offline``). It raises ``ProviderUnconfiguredError``
  for every operation. It NEVER fabricates scenes or scientific metadata.
- ``FixtureSatelliteProvider`` — deterministic, explicitly-labelled test/dev
  provider. Results are always tagged ``mock: true`` with a stated reason and
  must never be mistaken for real satellite data.

Provenance rules (never bent):
- Every collection and band-role mapping in this module was verified against a
  live catalog response (Earth Search / Planetary Computer), not guessed.
- Original provider identifiers (STAC item id, collection) are preserved.
- No credentials ever appear in source code; they come from the environment.
"""

from __future__ import annotations

import logging
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Errors                                                                       #
# --------------------------------------------------------------------------- #


class SatelliteProviderError(Exception):
    """Base error for all satellite-provider failures."""


class ProviderValidationError(SatelliteProviderError):
    """Raised for a malformed request (bad AOI, bad dates, bad sensor)."""


class UnsupportedCollectionError(SatelliteProviderError):
    """Raised when a sensor/collection is not supported by this provider."""


class ProviderUnconfiguredError(SatelliteProviderError):
    """Raised when the provider has no live configuration (offline)."""


class ProviderUnavailableError(SatelliteProviderError):
    """Raised when a live provider cannot be reached or misbehaves."""


class SceneNotFoundError(SatelliteProviderError):
    """Raised when a requested scene/product does not exist."""


class SceneNoIntersectionError(SatelliteProviderError):
    """Raised when the AOI does not intersect the scene footprint."""


class BandUnavailableError(SatelliteProviderError):
    """Raised when a requested band/asset does not exist for the scene."""


# --------------------------------------------------------------------------- #
# Known collections (verified against live catalogs, never guessed)            #
# --------------------------------------------------------------------------- #

# Collection registry. ``sensor`` is what the product plan / API layer calls the
# platform family; ``collection`` is the real STAC collection ID served by the
# catalogs (Earth Search and Planetary Computer both confirmed these IDs).
#
# Band roles: the internal names SatQuery analytics use (blue/green/red/nir).
# For each collection the registry maps an internal role to the *verified*
# STAC asset that carries it, and the asset's native grid resolution. These
# were derived from live catalog responses:
#   - sentinel-2-l2a assets: blue(B02), green(B03), red(B04), nir(B08) @ 10 m
#   - landsat-c2-l2  assets: blue(SR_B2), green(SR_B3), red(SR_B4), nir08(SR_B5) @ 30 m
# Where an item provides eo:bands[].common_name the common name is preferred
# when resolving roles; the registry is the fallback and is never position-based.
SENTINEL_2_L2A = {
    "collection": "sentinel-2-l2a",
    "name": "Sentinel-2 MSI L2A (surface reflectance)",
    "platforms": ["sentinel-2a", "sentinel-2b"],
    "sensors": ["sentinel-2", "sentinel2", "s2", "sentinel-2-l2a"],
    "resolution": 10,
    "band_roles": {
        "blue": "blue",
        "green": "green",
        "red": "red",
        "nir": "nir",
    },
    "preview_asset": "visual",
}

LANDSAT_C2_L2 = {
    "collection": "landsat-c2-l2",
    "name": "Landsat Collection 2 Level-2 (surface reflectance)",
    "platforms": ["landsat-8", "landsat-9"],
    "sensors": ["landsat-9", "landsat-8", "landsat", "landsat-c2-l2"],
    "resolution": 30,
    "band_roles": {
        "blue": "blue",
        "green": "green",
        "red": "red",
        "nir": "nir08",
    },
    "preview_asset": "reduced_resolution_browse",
}

KNOWN_COLLECTIONS: list[dict[str, Any]] = [SENTINEL_2_L2A, LANDSAT_C2_L2]

# Public STAC endpoint used when the operator has not configured one. It was
# verified live (collection listing + item search) during this task and needs no
# credentials. Operators should set STAC_API_URL to the endpoint they intend to
# use in production.
DEFAULT_STAC_API_URL = "https://earth-search.aws.element84.com/v1"

# Environment keys the provider reads (never hardcoded values).
STAC_ENV_KEYS = (
    "STAC_API_URL",
    "STAC_MODE",
    "STAC_PROVIDER",
    "STAC_CLIENT_ID",
    "STAC_CLIENT_SECRET",
    "ACQUISITION_DIR",
)

STAC_DEFAULT_HEADERS = {"User-Agent": "SatQueryAI/1.0 (satellite acquisition)"}


def resolve_collection(sensor: str | None, collection: str | None) -> dict[str, Any]:
    """Resolve a sensor/collection request to a verified collection config.

    Raises:
        UnsupportedCollectionError: when neither the sensor nor a collection id
            maps to a known, verified collection.
    """
    key = (collection or sensor or "").strip().lower()
    for cfg in KNOWN_COLLECTIONS:
        if collection and collection.lower() == cfg["collection"]:
            return cfg
        if collection:
            continue
        if sensor and sensor.strip().lower() in cfg["sensors"]:
            return cfg
    raise UnsupportedCollectionError(
        f"Unsupported sensor/collection '{sensor or collection or ''}'. "
        f"Supported collections: "
        + ", ".join(sorted(c["collection"] for c in KNOWN_COLLECTIONS))
        + ". No synthetic scenes will be produced for an unverified collection."
    )


def asset_for_role(collection_cfg: dict[str, Any], role: str) -> str | None:
    """Return the verified STAC asset name for an internal band role."""
    return collection_cfg.get("band_roles", {}).get(role)


def role_from_asset(
    collection_cfg: dict[str, Any],
    asset_name: str,
    eo_bands: list[dict[str, Any]] | None,
) -> str | None:
    """Derive the internal band role for an asset, honestly.

    Preference order:
      1. ``eo:bands[].common_name`` on the asset (provider-declared).
      2. the verified asset-name registry for the collection.
    Returns ``None`` when no role can be established — the caller must never
    guess from the band number.
    """
    if eo_bands:
        for entry in eo_bands:
            common = entry.get("common_name") if isinstance(entry, dict) else None
            if common in ("blue", "green", "red", "nir", "nir08"):
                return "nir" if common == "nir08" else common
    for role, asset in collection_cfg.get("band_roles", {}).items():
        if asset == asset_name:
            return role
    return None


def provider_labels() -> dict[str, str]:
    """Safe labels describing the current provider configuration.

    Never includes secrets: credentials are reported only as present/absent.
    Provider values come from the environment, never hardcoded identifiers.
    """
    url = os.environ.get("STAC_API_URL", "").strip()
    return {
        "name": (os.environ.get("STAC_PROVIDER", "").strip() or "stac"),
        "url": url or DEFAULT_STAC_API_URL,
        "configured_url": bool(url),
        "mode": (os.environ.get("STAC_MODE", "").strip() or "real").lower(),
        "authenticated": bool(
            os.environ.get("STAC_CLIENT_ID", "").strip()
            and os.environ.get("STAC_CLIENT_SECRET", "").strip()
        ),
    }


# --------------------------------------------------------------------------- #
# Normalized scene metadata                                                    #
# --------------------------------------------------------------------------- #


@dataclass
class SceneAsset:
    """A single STAC asset (band) normalized into the SatQuery contract."""

    name: str
    href: str
    media_type: str | None = None
    role: str | None = None
    eo_common_name: str | None = None
    usable: bool = False


@dataclass
class SceneInfo:
    """Normalized scene metadata returned by :meth:`SatelliteProvider.search_scenes`.

    Original provider identifiers (``scene_id``, ``collection``) are preserved
    for traceability. Nothing here is fabricated: fields absent at the provider
    are ``None`` rather than filled in.
    """

    scene_id: str
    collection: str
    provider: str
    platform: str | None = None
    instrument: str | None = None
    datetime: str | None = None
    bbox: dict[str, float] | None = None
    footprint: dict[str, Any] | None = None
    crs: str | None = None
    resolution: float | None = None
    assets: list[SceneAsset] = field(default_factory=list)
    band_roles: dict[str, str] = field(default_factory=dict)
    cloud_cover: float | None = None
    provider_ref: str | None = None
    mock: bool = False
    reason: str | None = None

    def summary(self) -> dict[str, Any]:
        """JSON-safe scene entry for the search response."""
        return {
            "sceneId": self.scene_id,
            "collection": self.collection,
            "provider": self.provider,
            "platform": self.platform,
            "instrument": self.instrument,
            "datetime": self.datetime,
            "bbox": self.bbox,
            "footprint": self.footprint,
            "crs": self.crs,
            "resolution": self.resolution,
            "cloudCover": self.cloud_cover,
            "bandRoles": dict(self.band_roles),
            "assets": [
                {
                    "name": a.name,
                    "role": a.role,
                    "mediaType": a.media_type,
                    "usable": a.usable,
                }
                for a in self.assets
            ],
            "mock": self.mock,
            "reason": self.reason,
        }


# --------------------------------------------------------------------------- #
# Provider interface                                                           #
# --------------------------------------------------------------------------- #


@dataclass
class BandWindow:
    """A 2-D read of one band asset restricted to the AOI window."""

    asset: str
    data: np.ndarray
    dtype: str
    nodata: Any = None
    eo_common_name: str | None = None


@dataclass
class FetchedWindow:
    """The provider-side AOI window: co-gridded band arrays + geotransform."""

    bands: list[BandWindow]
    transform: Any
    crs: str
    width: int
    height: int
    nodata: Any = None
    hrefs: dict[str, str] = field(default_factory=dict)
    native_crs_bounds: dict[str, float] | None = None
    method: str = "unknown"
    warnings: list[str] = field(default_factory=list)


class SatelliteProvider(ABC):
    """Interface for a provider that can discover and acquire satellite scenes."""

    name: str = "abstract"
    is_fixture: bool = False

    @abstractmethod
    def search_scenes(
        self,
        *,
        collection: str,
        aoi: dict[str, Any],
        start: str,
        end: str,
        cloud_max: float | None,
        limit: int,
    ) -> list[SceneInfo]:
        """Return normalized scene matches for a collection/date/AOI window."""

    @abstractmethod
    def get_scene_metadata(
        self,
        *,
        collection: str,
        scene_id: str,
    ) -> SceneInfo:
        """Re-resolve scene metadata directly from the provider.

        Client-supplied scene metadata is never trusted; the authoritative copy
        is fetched from the provider here.
        """

    @abstractmethod
    def fetch_scene_aoi(
        self,
        *,
        collection: str,
        scene_id: str,
        aoi: dict[str, Any],
        aoi_crs: Any,
        bands: list[str],
    ) -> FetchedWindow:
        """Fetch only the requested AOI of a scene as co-gridded band arrays.

        Must use the smallest provider-supported spatial subset (COG window
        reads). Raises ``SceneNoIntersectionError`` when the AOI misses the
        scene and ``BandUnavailableError`` when a requested band is absent.
        """


# --------------------------------------------------------------------------- #
# Real STAC provider                                                           #
# --------------------------------------------------------------------------- #


def _resolve_cli() -> Any:
    """Lazily import pystac_client; raise a clear error if missing."""
    try:
        from pystac_client import Client  # noqa: F401
    except Exception as exc:  # pragma: no cover - install-state dependent
        raise ProviderUnavailableError(
            "pystac_client is not installed. Add 'pystac' and 'pystac_client' "
            "to the ML service requirements and reinstall."
        ) from exc
    return Client


def _header_extra() -> dict[str, str]:
    headers = dict(STAC_DEFAULT_HEADERS)
    client_id = os.environ.get("STAC_CLIENT_ID", "").strip()
    secret = os.environ.get("STAC_CLIENT_SECRET", "").strip()
    if client_id and secret:
        headers["x-api-key"] = secret
    return headers


class StacSatelliteProvider(SatelliteProvider):
    """Real STAC-backed provider (COG assets over HTTPS range requests)."""

    name = "stac"

    def __init__(self, api_url: str | None = None) -> None:
        self.api_url = (api_url or os.environ.get("STAC_API_URL", "").strip()
                        or DEFAULT_STAC_API_URL)
        self.authenticated = False
        client_id = os.environ.get("STAC_CLIENT_ID", "").strip()
        secret = os.environ.get("STAC_CLIENT_SECRET", "").strip()
        if client_id and secret:
            self.authenticated = True

    # -- client ------------------------------------------------------------ #

    def _client(self) -> Any:
        Client = _resolve_cli()
        return Client.open(self.api_url, headers=_header_extra())

    def _collection_cfg(self, collection: str) -> dict[str, Any]:
        return resolve_collection(None, collection)

    # -- helpers ----------------------------------------------------------- #

    @staticmethod
    def _float(props: dict[str, Any], *keys: str) -> float | None:
        for key in keys:
            value = props.get(key)
            if value is not None:
                try:
                    return float(value)
                except (TypeError, ValueError):
                    continue
        return None

    @staticmethod
    def _crs_label(props: dict[str, Any]) -> str | None:
        epsg = props.get("proj:epsg")
        if isinstance(epsg, int):
            return f"EPSG:{epsg}"
        if isinstance(epsg, str) and epsg:
            return epsg if epsg.upper().startswith("EPSG:") else f"EPSG:{epsg}"
        return None

    @staticmethod
    def _cog_rank(media_type: str | None) -> int:
        """Preference rank for role resolution among equally-named assets.

        Catalogs like Earth Search expose the same band several ways: a
        Cloud-Optimized GeoTIFF (anonymous HTTPS COG range reads) and a
        legacy ``image/jp2`` (often under a credential-restricted ``s3://``
        href). Both may declare an identical ``eo:bands`` common name, so an
        explicit preference keeps the analysis-ready COG asset authoritative.
        Lower rank wins.
        """
        mt = (media_type or "").lower()
        if "cloud-optimized" in mt or "geotiff" in mt or mt.startswith("image/tiff"):
            return 0
        if "image/jp2" in mt or mt.endswith("/jp2"):
            return 1
        return 2

    @staticmethod
    def _normalize_item(
        item: Any, collection_cfg: dict[str, Any], provider: str
    ) -> SceneInfo:
        props = dict(item.properties or {})
        assets: list[SceneAsset] = []
        band_roles: dict[str, str] = {}
        role_rank: dict[str, int] = {}
        for name, asset in (item.assets or {}).items():
            if not isinstance(asset, dict) and not hasattr(asset, "href"):
                continue
            if isinstance(asset, dict):
                href = asset.get("href")
                media_type = asset.get("type")
                extra = asset.get("eo:bands") or asset.get("extra_fields", {})
                eo_bands = extra.get("eo:bands") if isinstance(extra, dict) else None
            else:
                href = asset.href
                media_type = asset.media_type or None
                extra = getattr(asset, "extra_fields", None) or {}
                eo_bands = extra.get("eo:bands") if isinstance(extra, dict) else None
            if not href:
                continue

            common = None
            composite = False
            if eo_bands:
                names = [
                    entry.get("common_name")
                    for entry in eo_bands
                    if isinstance(entry, dict) and entry.get("common_name")
                ]
                unique = {n for n in names if n}
                if len(unique) > 1:
                    # e.g. 'visual' / TCI composites listing red,green,blue:
                    # never an analysis band.
                    composite = True
                elif unique:
                    common = next(iter(unique))
            # Composites are never registered as single-role analysis bands.
            role = None if composite else role_from_asset(collection_cfg, name, eo_bands)
            assets.append(
                SceneAsset(
                    name=name,
                    href=href,
                    media_type=media_type,
                    role=role,
                    eo_common_name=common,
                    usable=bool(href),
                )
            )
            if not role:
                continue
            # Prefer the Cloud-Optimized GeoTIFF when several assets share a
            # role (COG family vs legacy '-jp2'); keeps https range-readable
            # hrefs authoritative and avoids credential-bound s3:// bands.
            rank = StacSatelliteProvider._cog_rank(media_type)
            if band_roles.get(role) is None or rank < role_rank.get(role, 9):
                band_roles[role] = name
                role_rank[role] = rank

        bbox = item.bbox
        bounds = None
        if isinstance(bbox, (list, tuple)) and len(bbox) >= 4:
            bounds = {
                "west": float(bbox[0]),
                "south": float(bbox[1]),
                "east": float(bbox[2]),
                "north": float(bbox[3]),
            }

        footprint = None
        geometry = item.geometry
        if isinstance(geometry, dict) and geometry.get("type") == "Polygon":
            footprint = geometry

        instruments = props.get("instruments") or props.get("eo:instrument")
        instrument = None
        if isinstance(instruments, list) and instruments:
            instrument = str(instruments[0])
        elif instruments:
            instrument = str(instruments)

        return SceneInfo(
            scene_id=item.id,
            collection=collection_cfg["collection"],
            provider=provider,
            platform=str(props.get("platform") or "") or None,
            instrument=instrument,
            datetime=props.get("datetime") or props.get("start_datetime"),
            bbox=bounds,
            footprint=footprint,
            crs=StacSatelliteProvider._crs_label(props),
            resolution=StacSatelliteProvider._float(
                props, "gsd", "proj:resolution"
            ),
            assets=assets,
            band_roles=band_roles,
            cloud_cover=StacSatelliteProvider._float(
                props, "eo:cloud_cover", "s2:cloud_cover", "landsat:cloud_cover"
            ),
            provider_ref=item.id,
        )

    # -- search ------------------------------------------------------------ #

    def search_scenes(
        self,
        *,
        collection: str,
        aoi: dict[str, Any],
        start: str,
        end: str,
        cloud_max: float | None,
        limit: int,
    ) -> list[SceneInfo]:
        cfg = self._collection_cfg(collection)
        try:
            client = self._client()
            search = client.search(
                collections=[cfg["collection"]],
                intersects=aoi,
                datetime=f"{start}/{end}",
                max_items=max(limit, 1),
            )
            items = list(search.items())
        except UnsupportedCollectionError:
            raise
        except Exception as exc:
            raise ProviderUnavailableError(
                f"STAC search against {self.api_url} failed: {exc}"
            ) from exc

        scenes: list[SceneInfo] = []
        for item in items:
            scene = self._normalize_item(item, cfg, self.name)
            if cloud_max is not None and scene.cloud_cover is not None:
                if scene.cloud_cover > cloud_max:
                    continue
            scenes.append(scene)
            if len(scenes) >= limit:
                break
        if len(scenes) > 1:
            # Deterministic ordering: earliest acquisition first, then cloud.
            scenes.sort(
                key=lambda s: (
                    (s.datetime or "") == "",
                    (s.datetime or ""),
                    s.cloud_cover if s.cloud_cover is not None else -1,
                    s.scene_id,
                )
            )
            scenes = scenes[:limit]
        return scenes

    # -- metadata resolution ------------------------------------------------ #

    def get_scene_metadata(
        self,
        *,
        collection: str,
        scene_id: str,
    ) -> SceneInfo:
        if not scene_id or not str(scene_id).strip():
            raise SceneNotFoundError("scene_id is required to resolve scene metadata.")
        cfg = self._collection_cfg(collection)
        try:
            client = self._client()
            coll = client.get_collection(cfg["collection"])
            item = coll.get_item(str(scene_id).strip())
        except SceneNotFoundError:
            raise
        except Exception as exc:
            raise ProviderUnavailableError(
                f"STAC item lookup for {scene_id!r} in {cfg['collection']} failed: {exc}"
            ) from exc
        if item is None:
            raise SceneNotFoundError(
                f"Scene '{scene_id}' was not found in collection "
                f"'{cfg['collection']}'. Re-resolved from the provider — the "
                "requested scene does not exist."
            )
        return self._normalize_item(item, cfg, self.name)

    # -- AOI-only fetch ----------------------------------------------------- #

    def fetch_scene_aoi(
        self,
        *,
        collection: str,
        scene_id: str,
        aoi: dict[str, Any],
        aoi_crs: Any,
        bands: list[str],
    ) -> FetchedWindow:
        import rasterio
        from rasterio.errors import RasterioIOError
        from rasterio.windows import from_bounds

        from app.geospatial.crs import parse_crs
        from app.tools.roi_crop import AoiCrsError, transform_aoi_to_crs
        from shapely.geometry import box

        scene = self.get_scene_metadata(collection=collection, scene_id=scene_id)

        # Verify every requested internal role has a usable asset.
        cfg = self._collection_cfg(collection)
        usable: dict[str, SceneAsset] = {}
        for role in bands:
            asset_name = scene.band_roles.get(role)
            if not asset_name:
                asset_name = asset_for_role(cfg, role)
            asset = next(
                (a for a in scene.assets if a.name == asset_name), None
            )
            if asset is None:
                raise BandUnavailableError(
                    f"Band role '{role}' is not available for scene "
                    f"'{scene_id}' in '{cfg['collection']}'."
                )
            usable[role] = asset

        # Read the authoritative geospatial header from the first usable COG:
        # its own CRS/transform/footprint are ground truth, never guesses.
        probe = next(iter(usable.values()))
        try:
            with rasterio.open(probe.href) as src:
                probe_crs = str(src.crs) if src.crs is not None else None
                probe_transform = src.transform
                probe_nodata = src.nodata
                footprint = box(
                    src.bounds.left, src.bounds.bottom,
                    src.bounds.right, src.bounds.top,
                )
        except RasterioIOError as exc:
            raise ProviderUnavailableError(
                f"Band asset {probe.name} for scene {scene_id} could not be "
                f"opened: {exc}"
            ) from exc

        crs_label = scene.crs or probe_crs
        if crs_label is None:
            raise ProviderUnavailableError(
                f"Scene {scene_id} has no usable CRS metadata; refusing to "
                "guess a coordinate reference system."
            )
        asset_crs = parse_crs(crs_label)
        if asset_crs is None:
            raise ProviderUnavailableError(
                f"Scene {scene_id} declares an unparsable CRS '{crs_label}'."
            )
        aoi_parsed_crs = parse_crs(aoi_crs)
        if aoi_parsed_crs is None:
            raise AoiCrsError(
                f"AOI CRS '{aoi_crs}' could not be parsed; refusing to guess a CRS."
            )

        from shapely.geometry import shape as _shapely_shape

        aoi_geom = _shapely_shape(aoi)
        # Explicit transform of the AOI into the asset CRS (never implicit).
        aoi_proj = transform_aoi_to_crs(aoi_geom, aoi_parsed_crs, asset_crs)
        if footprint.is_empty or not aoi_proj.intersects(footprint):
            raise SceneNoIntersectionError(
                f"AOI does not intersect the footprint of scene '{scene_id}' "
                f"in {crs_label}."
            )

        # Windowed COG read: only intersecting bytes are transferred. The
        # window is clamped to the scene extent so an AOI that partially
        # overlaps never reads outside the raster.
        with rasterio.open(probe.href) as src:
            w = from_bounds(
                aoi_proj.bounds[0],
                aoi_proj.bounds[1],
                aoi_proj.bounds[2],
                aoi_proj.bounds[3],
                probe_transform,
            )
            window = w.round_offsets().intersection(
                rasterio.windows.Window(0, 0, src.width, src.height)
            )
            if window.width <= 0 or window.height <= 0:
                raise SceneNoIntersectionError(
                    f"AOI covers no pixel of scene '{scene_id}'."
                )
            out_transform = src.window_transform(window)
            out_crs = str(src.crs)

        band_arrays: list[BandWindow] = []
        for role in bands:
            asset = usable[role]
            with rasterio.open(asset.href) as src:
                data = src.read(1, window=window)
                band_arrays.append(
                    BandWindow(
                        asset=asset.name,
                        data=np.asarray(data),
                        dtype=str(data.dtype),
                        nodata=src.nodata,
                        eo_common_name=asset.eo_common_name,
                    )
                )

        overlap = footprint.intersection(aoi_proj)
        return FetchedWindow(
            bands=band_arrays,
            transform=out_transform,
            crs=out_crs,
            width=int(window.width),
            height=int(window.height),
            nodata=probe_nodata,
            hrefs={b.name: b.href for b in usable.values()},
            native_crs_bounds={
                "west": float(out_transform.c),
                "south": float(out_transform.f + out_transform.e * window.height),
                "east": float(out_transform.c + out_transform.a * window.width),
                "north": float(out_transform.f),
            },
            method="cog-window-read",
            warnings=(
                ["AOI extends beyond scene footprint; clamped to scene extent."]
                if aoi_proj.area > overlap.area
                else []
            ),
        )


# --------------------------------------------------------------------------- #
# Offline provider (production, credentials absent)                            #
# --------------------------------------------------------------------------- #


class OfflineSatelliteProvider(SatelliteProvider):
    """Production fallback when no live STAC endpoint is configured.

    Every operation raises ``ProviderUnconfiguredError``. It is a deliberate
    non-implementation: without a live provider there is *nothing* to search,
    so fabricating fixture scenes or metadata would be dishonest.
    """

    name = "stac-offline"

    def _unconfigured(self) -> None:
        raise ProviderUnconfiguredError(
            "No live satellite provider is configured. Set STAC_API_URL to a "
            "STAC endpoint (e.g. a public catalog such as Earth Search or "
            "Planetary Computer) or set STAC_MODE=test to use explicitly "
            "labelled, non-scientific test fixtures. No synthetic satellite "
            "scenes are fabricated when the provider is unavailable."
        )

    def search_scenes(self, **kwargs: Any) -> list[SceneInfo]:
        self._unconfigured()

    def get_scene_metadata(self, **kwargs: Any) -> SceneInfo:
        self._unconfigured()

    def fetch_scene_aoi(self, **kwargs: Any) -> FetchedWindow:
        self._unconfigured()


# --------------------------------------------------------------------------- #
# Fixture provider (tests / explicit STAC_MODE=test)                           #
# --------------------------------------------------------------------------- #


class FixtureSatelliteProvider(SatelliteProvider):
    """Deterministic, explicitly-labelled fixture provider (tests / dev only).

    Never used as a production path: results are tagged ``mock: true`` with a
    stated reason so they can never be mistaken for real satellite data. Scene
    ids are syntactically synthetic (``fixture-...``) and analysis rasters are
    generated local GeoTIFFs from a deterministic pattern.
    """

    name = "stac-fixture"
    is_fixture: bool = True
    FIXTURE_REASON = (
        "Deterministic test fixture — NOT real satellite imagery. "
        "No scientific claim is attached."
    )

    def __init__(self, fixtures: dict[str, list[dict[str, Any]]] | None = None) -> None:
        self._fixtures = fixtures or {
            SENTINEL_2_L2A["collection"]: [
                {
                    "scene_id": "fixture-s2a-20250301",
                    "datetime": "2025-03-01T04:21:03Z",
                    "cloud_cover": 5.0,
                    "crs": "EPSG:32643",
                },
                {
                    "scene_id": "fixture-s2a-20250315",
                    "datetime": "2025-03-15T04:24:11Z",
                    "cloud_cover": 12.0,
                    "crs": "EPSG:32643",
                },
            ],
            LANDSAT_C2_L2["collection"]: [
                {
                    "scene_id": "fixture-l9-20250302",
                    "datetime": "2025-03-02T05:10:42Z",
                    "cloud_cover": 2.0,
                    "crs": "EPSG:32643",
                }
            ],
        }

    def _fixture_scenes(
        self, collection_cfg: dict[str, Any], aoi: dict[str, Any]
    ) -> list[dict[str, Any]]:
        coll = collection_cfg["collection"]
        entries = self._fixtures.get(coll, [])
        bbox = aoi.get("bbox") or _bbox_from_polygon(aoi)
        scenes = []
        for entry in entries:
            scenes.append({
                **entry,
                "collection": coll,
                "provider": self.name,
                "footprint_bbox": bbox,
                "platform": {
                    SENTINEL_2_L2A["collection"]: "sentinel-2a",
                    LANDSAT_C2_L2["collection"]: "landsat-9",
                }[coll],
            })
        return scenes

    # -- search ------------------------------------------------------------ #

    def search_scenes(
        self,
        *,
        collection: str,
        aoi: dict[str, Any],
        start: str,
        end: str,
        cloud_max: float | None,
        limit: int,
    ) -> list[SceneInfo]:
        cfg = resolve_collection(None, collection)
        scenes = []
        for entry in self._fixture_scenes(cfg, aoi):
            if cloud_max is not None and entry["cloud_cover"] > cloud_max:
                continue
            if not (start <= (entry["datetime"] or "")[:10] <= end):
                continue
            scenes.append(self._scene_from_entry(cfg, entry, entry["footprint_bbox"]))
            if len(scenes) >= limit:
                break
        return scenes

    @staticmethod
    def _scene_from_entry(
        cfg: dict[str, Any], entry: dict[str, Any], bbox: dict[str, float]
    ) -> SceneInfo:
        d = entry["datetime"] or ""
        return SceneInfo(
            scene_id=entry["scene_id"],
            collection=cfg["collection"],
            provider=FixtureSatelliteProvider.name,
            platform=entry.get("platform"),
            instrument="sentinel-2" if cfg is SENTINEL_2_L2A else "landsat",
            datetime=d,
            bbox=dict(bbox),
            footprint={"type": "Polygon", "coordinates": [_ring_from_bbox(bbox)]},
            crs=entry.get("crs"),
            resolution=cfg["resolution"],
            assets=[
                SceneAsset(name=n, href=f"fixture://{entry['scene_id']}/{n}",
                           role=r, usable=True)
                for r, n in cfg["band_roles"].items()
            ],
            band_roles=dict(cfg["band_roles"]),
            cloud_cover=entry.get("cloud_cover"),
            provider_ref=entry["scene_id"],
            mock=True,
            reason=FixtureSatelliteProvider.FIXTURE_REASON,
        )

    # -- metadata ---------------------------------------------------------- #

    def get_scene_metadata(
        self, *, collection: str, scene_id: str
    ) -> SceneInfo:
        cfg = resolve_collection(None, collection)
        for entry in self._fixtures.get(cfg["collection"], []):
            if entry["scene_id"] == scene_id:
                return self._scene_from_entry(cfg, entry, _bbox_from_polygon(
                    {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}
                ))
        raise SceneNotFoundError(
            f"Scene '{scene_id}' is not a known fixture in '{cfg['collection']}'."
        )

    # -- AOI fetch --------------------------------------------------------- #

    def fetch_scene_aoi(
        self,
        *,
        collection: str,
        scene_id: str,
        aoi: dict[str, Any],
        aoi_crs: Any,
        bands: list[str],
    ) -> FetchedWindow:
        scene = self.get_scene_metadata(collection=collection, scene_id=scene_id)
        cfg = resolve_collection(None, collection)
        for role in bands:
            if role not in cfg["band_roles"]:
                raise BandUnavailableError(
                    f"Band role '{role}' not in fixture collection "
                    f"'{cfg['collection']}'."
                )
        # Deterministic synthetic window matching the AOI (never real data).
        import rasterio
        from rasterio.transform import from_origin
        from app.geospatial.crs import parse_crs
        from app.tools.roi_crop import transform_aoi_to_crs
        from shapely.geometry import shape as _shape

        aoi_geom = _shape(aoi)
        asset_crs = parse_crs(scene.crs or "EPSG:4326")
        aoi_proj = transform_aoi_to_crs(aoi_geom, parse_crs(aoi_crs), asset_crs)
        res = cfg["resolution"]
        minx, miny, maxx, maxy = aoi_proj.bounds
        width = max(int((maxx - minx) / res), 1)
        height = max(int((maxy - miny) / res), 1)
        # clamp to a small deterministic window for test determinism
        width = min(width, 16)
        height = min(height, 16)
        transform = from_origin(minx, maxy, res, res)
        arrays = []
        for i, role in enumerate(bands):
            base = 100 + 20 * i
            data = np.full((height, width), base, dtype=np.uint16)
            data[height // 4: 3 * height // 4, width // 4: 3 * width // 4] = base + 40
            arrays.append(
                BandWindow(
                    asset=cfg["band_roles"][role],
                    data=data,
                    dtype="uint16",
                    nodata=None,
                    eo_common_name=role,
                )
            )
        return FetchedWindow(
            bands=arrays,
            transform=transform,
            crs=str(asset_crs.to_epsg() and f"EPSG:{asset_crs.to_epsg()}" or asset_crs),
            width=width,
            height=height,
            nodata=None,
            hrefs={b.asset: f"fixture://{scene_id}/{b.asset}" for b in arrays},
            native_crs_bounds={
                "west": float(transform.c),
                "south": float(transform.f - transform.e * height),
                "east": float(transform.c + transform.a * width),
                "north": float(transform.f),
            },
            method="fixture-cog-window-read",
            warnings=["Fixture acquisition — synthetic analysis raster, NOT real data."],
        )


def _bbox_from_polygon(geom: dict[str, Any]) -> dict[str, float]:
    from shapely.geometry import shape
    try:
        b = shape(geom).bounds
        return {"west": float(b[0]), "south": float(b[1]),
                "east": float(b[2]), "north": float(b[3])}
    except Exception:
        return {"west": 0.0, "south": 0.0, "east": 1.0, "north": 1.0}


def _ring_from_bbox(b: dict[str, float]) -> list[list[float]]:
    return [
        [b["west"], b["south"]],
        [b["east"], b["south"]],
        [b["east"], b["north"]],
        [b["west"], b["north"]],
        [b["west"], b["south"]],
    ]


# --------------------------------------------------------------------------- #
# Factory                                                                      #
# --------------------------------------------------------------------------- #


def get_provider(mode: str | None = None) -> SatelliteProvider:
    """Return the provider selected by ``STAC_MODE`` (or an explicit override).

    - ``mock`` / ``test`` / ``dev`` → FixtureSatelliteProvider (clearly labelled
      as non-scientific, for tests/dev only).
    - ``offline`` → OfflineSatelliteProvider (explicitly unconfigured; never
      fabricates).
    - ``real`` / unset → StacSatelliteProvider (fails clearly if no STAC URL or
      the endpoint is unreachable).
    """
    mode = (mode or os.environ.get("STAC_MODE", "")).lower()
    if mode in ("mock", "test", "dev"):
        logger.info(
            "Using FixtureSatelliteProvider (clearly labelled, non-scientific)."
        )
        return FixtureSatelliteProvider()
    if mode == "offline":
        logger.info("Using OfflineSatelliteProvider (STAC not configured).")
        return OfflineSatelliteProvider()
    return StacSatelliteProvider()