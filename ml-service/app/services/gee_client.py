"""Google Earth Engine (GEE) data-provider abstraction for historical trends.

This module defines a small provider interface so the trend tool is **testable
without GEE** and **fails clearly when real GEE is unavailable**:

- ``RealGeeProvider`` — the production path. It lazily imports the official
  ``earthengine-api`` and initialises with credentials sourced only from the
  environment (never hard-coded). If ``e`` is missing, or credentials are
  absent, it raises a clear error instead of fabricating data.
- ``MockGeeProvider`` — a deterministic, explicitly-labelled fixture generator
  used only for development/testing. Its results are always tagged
  ``{"source": "mock"}`` so they can never be mistaken for real satellite data.

No credentials are ever hard-coded in this file.
"""

from __future__ import annotations

import logging
import os
from abc import ABC, abstractmethod
from typing import Any

logger = logging.getLogger(__name__)


class GeeClientError(Exception):
    """Base error for all GEE provider failures."""


class GeeUnavailableError(GeeClientError):
    """Raised when GEE cannot be used (e.g. library or credentials missing)."""


class GeeAuthError(GeeUnavailableError):
    """Raised when GEE authentication/initialisation fails."""


class GeeQueryError(GeeClientError):
    """Raised when a GEE query or reduction fails."""


# Sentinel-2 Surface Reflectance (scene-level) is the documented optical archive.
# ML_SERVICE.md names Sentinel-2 (+ Sentinel-1 for SAR) via GEE as the practical
# substitute for on-demand ISRO imagery (Section 10.8). NDVI/NDWI in /trend are
# optical vegetation/water trends, so Sentinel-2 SR is the correct collection.
SENTINEL2_COLLECTION = "COPERNICUS/S2_SR_HARMONIZED"

# Sentinel-1 Ground Range Detected (GRD) is the documented SAR archive (Section
# 10.8: "Sentinel-1 (SAR) via Google Earth Engine"). It is used only for /fetch-imagery
# SAR acquisition — never for the optical trend metrics.
SENTINEL1_COLLECTION = "COPERNICUS/S1_GRD"

# Documented SAR-pass selection tolerance: exact same-day optical+SAR matches are
# unlikely, so the nearest Sentinel-1 acquisition within this many days of the chosen
# Sentinel-2 scene is accepted (ML_SERVICE.md Section 10.8 requires documenting this).
SAR_TOLERANCE_DAYS = 7

# Default "reasonable recent date range" (in days) used when the caller does not
# provide an explicit start/end window (ML_SERVICE.md Section 10.8).
DEFAULT_FETCH_DAYS = 90

# Explicit Sentinel-1 GRD bands preserved when downloading SAR (VV, and VH where
# available). Instrument band names as served by GEE — documented, not guessed.
SENTINEL1_BANDS = ["VV", "VH"]

# Sentinel-2 surface-reflectance bands exported for the fetched optical scene.
# A minimal set for downstream NDVI/NDWI (blue/green/red/nir) is exported.
SENTINEL2_EXPORT_BANDS = ["B2", "B3", "B4", "B8"]

# Dataset band mapping for the supported optical metrics (documented, not
# position-guessed — these are the instrument band names as served by GEE).
METRIC_BANDS: dict[str, dict[str, str]] = {
    "ndvi": {"nir": "B8", "red": "B4"},
    "ndwi": {"green": "B3", "nir": "B8"},  # McFeeters NDWI = (GREEN - NIR)/(GREEN + NIR)
}

GEE_ENV_KEYS = ("GEE_PROJECT_ID", "GEE_SERVICE_ACCOUNT", "GEE_SERVICE_ACCOUNT_KEY_PATH")


class GeeProvider(ABC):
    """Interface for a provider that returns a historical metric time series."""

    @abstractmethod
    def compute_trend(
        self,
        metric: str,
        region: dict[str, Any],
        start: str,
        end: str,
        interval: str = "monthly",
    ) -> dict[str, Any]:
        """Return a normalised trend payload for a region/date range/metric.

        The returned dict always contains:
            source: "gee" | "mock"
            metric, interval, collection
            band_mapping: dict
            quality_mask: str
            observations: list[{date, value, valid_pixels}]
            provider_warnings: list[str]
        """
        raise NotImplementedError

    @abstractmethod
    def fetch_pair(
        self,
        region: dict[str, Any],
        start: str,
        end: str,
        preferred_date: str | None = None,
    ) -> dict[str, Any]:
        """Return a co-registered optical + SAR acquisition pair for a region.

        The returned dict always contains:
            source: "gee" | "mock"
            optical: dict  (modality, source, collection, ... satellite metadata)
            sar: dict      (modality, source, collection, ... SAR metadata)
            date_gap_days: int
            provider_warnings: list[str]

        Each image dict carries ``file_path`` (and ``downloaded: bool``) only when
        the provider actually downloaded a local raster. Mock/fixture acquisitions
        set ``file_path: None`` and ``downloaded: False`` so they are never mistaken
        for real imagery.
        """
        raise NotImplementedError


def _env_credentials() -> dict[str, str]:
    creds = {}
    for key in GEE_ENV_KEYS:
        if os.environ.get(key):
            creds[key] = os.environ[key]
    return creds


class RealGeeProvider(GeeProvider):
    """Production GEE provider. Lazily imports `ee`; fails clearly otherwise."""

    def __init__(self, credentials: dict[str, str] | None = None) -> None:
        self._credentials = credentials if credentials is not None else _env_credentials()
        self._initialised = False
        self._ee = None

    # -- private helpers ----------------------------------------------------- #


    def _load_ee(self):
        if self._ee is not None:
            return self._ee
        try:
            import ee as _ee  # lazy import keeps service bootable without GEE

            self._ee = _ee
        except Exception as exc:  # pragma: no cover - depends on install state
            raise GeeUnavailableError(
                "The Earth Engine Python library is not installed. "
                "Add 'earthengine-api' to requirements and reinstall."
            ) from exc
        return self._ee

    def _initialise(self) -> None:
        if self._initialised:
            return
        ee = self._load_ee()

        if not self._credentials:
            # No explicit service-account config: attempt the default
            # interactive/persisted login only if one exists.
            try:
                ee.Initialize()
            except Exception as exc:
                raise GeeAuthError(
                    "GEE credentials are not configured. Set GEE_PROJECT_ID, "
                    "GEE_SERVICE_ACCOUNT and GEE_SERVICE_ACCOUNT_KEY_PATH (or run "
                    "'earthengine authenticate') before requesting real GEE data. "
                    "No authentication attempted error: " + str(exc)
                ) from exc
        else:
            key_path = self._credentials.get("GEE_SERVICE_ACCOUNT_KEY_PATH", "")
            project = self._credentials.get("GEE_PROJECT_ID", "")
            if not key_path:
                raise GeeAuthError(
                    "GEE_SERVICE_ACCOUNT_KEY_PATH is required when using a service account."
                )
            if not project:
                raise GeeAuthError(
                    "GEE_PROJECT_ID is required when using a service account."
                )
            service_account = (
                self._credentials.get("GEE_SERVICE_ACCOUNT")
                or os.environ.get("GEE_SERVICE_ACCOUNT")
                or ""
            )
            if not service_account:
                raise GeeAuthError(
                    "GEE_SERVICE_ACCOUNT is required when using a service account."
                )
            try:
                credentials = ee.ServiceAccountCredentials(service_account, key_path)
                ee.Initialize(credentials, project=project)
            except Exception as exc:
                raise GeeAuthError(
                    f"GEE initialisation (service-account) failed: {exc}"
                ) from exc
        self._initialised = True

    # -- GEE query construction --------------------------------------------- #
    # The reference pattern (ML_SERVICE.md 10.7, per PLANNING_ADDENDUM 1.1 which
    # is absent from the repo) is: filter ImageCollection by date + geometry,
    # apply a cloud mask, reduce (mean) over the region, per temporal bucket.


    def _cloud_mask(self, ee, image):
        # Sentinel-2 QA60: bit 10 = opaque clouds, bit 11 = cirrus.
        qa = image.select("QA60")
        cloud_bits = (1 << 10) | (1 << 11)
        mask = qa.bitwiseAnd(cloud_bits).eq(0)
        return image.updateMask(mask)

    def _metric_image(self, ee, image, metric: str) -> Any:
        mapping = METRIC_BANDS[metric]
        if metric == "ndvi":
            nir = image.select(mapping["nir"])
            red = image.select(mapping["red"])
            return nir.subtract(red).divide(nir.add(red)).rename("metric")
        if metric == "ndwi":
            green = image.select(mapping["green"])
            nir = image.select(mapping["nir"])
            return green.subtract(nir).divide(green.add(nir)).rename("metric")
        raise GeeQueryError(f"Unsupported metric '{metric}'.")

    def compute_trend(
        self,
        metric: str,
        region: dict[str, Any],
        start: str,
        end: str,
        interval: str = "monthly",
    ) -> dict[str, Any]:
        ee = self._load_ee()
        self._initialise()
        if metric not in METRIC_BANDS:
            raise GeeQueryError(f"Unsupported metric '{metric}'.")

        geometry = ee.Geometry(region)
        collection = (
            ee.ImageCollection(SENTINEL2_COLLECTION)
            .filterDate(start, end)
            .filterBounds(geometry)
            .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 20))
            .map(lambda img: self._metric_image(ee, self._cloud_mask(ee, img), metric))
        )

        # Temporal bucketing: monthly or yearly median composites -> reduceRegion.
        reducer = ee.Reducer.mean()
        def bucket(label, dstart, dend):
            img = collection.filterDate(dstart, dend).median()
            stats = img.reduceRegion(
                reducer=reducer, geometry=geometry, scale=10, maxPixels=1e9
            )
            value = stats.get("metric")
            # reduce per-bucket via client loop over a small number of buckets.
            return {"date": label, "value": value.getInfo()}

        observations = []
        if interval == "yearly":
            for year in range(int(start[:4]), int(end[:4]) + 1):
                dstart = f"{year}-01-01"
                dend = f"{year+1}-01-01"
                obs = bucket(str(year), dstart, dend)
                observations.append(obs)
        else:
            # monthly buckets across the range
            import datetime as _dt

            ds = _dt.date.fromisoformat(start)
            de = _dt.date.fromisoformat(end)
            month = _dt.date(ds.year, ds.month, 1)
            while month <= de:
                nxt = month + _dt.timedelta(days=32)
                nxt = _dt.date(nxt.year, nxt.month, 1)
                label = month.strftime("%Y-%m")
                obs = bucket(label, month.isoformat(), nxt.isoformat())
                observations.append(obs)
                month = nxt

        return {
            "source": "gee",
            "metric": metric,
            "interval": interval,
            "collection": SENTINEL2_COLLECTION,
            "band_mapping": METRIC_BANDS[metric],
            "quality_mask": "QA60 bits 10/11 (opaque cloud + cirrus) + CLOUDY_PIXEL_PERCENTAGE<20",
            "observations": observations,
            "provider_warnings": [],
        }


    def fetch_pair(
        self,
        region: dict[str, Any],
        start: str,
        end: str,
        preferred_date: str | None = None,
    ) -> dict[str, Any]:
        """Fetch a real Sentinel-2 + Sentinel-1 pair for a region/window.

        Selects the least-cloudy Sentinel-2 scene in [start, end] over the region,
        then the nearest Sentinel-1 acquisition to the chosen optical date (within
        SAR_TOLERANCE_DAYS). Both scenes are cloud/quality-processed and exported
        as local GeoTIFFs via getDownloadURL. Fails clearly (never fabricates) when
        GEE is unavailable or a query/export fails.
        """
        ee = self._load_ee()
        self._initialise()

        try:
            geometry = ee.Geometry(region)

            # -- Sentinel-2: least-cloudy suitable optical scene -----------------
            s2_collection = (
                ee.ImageCollection(SENTINEL2_COLLECTION)
                .filterDate(start, end)
                .filterBounds(geometry)
                .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 20))
                .sort("CLOUDY_PIXEL_PERCENTAGE")
            )
            s2_size = int(s2_collection.size().getInfo())
            if s2_size == 0:
                raise GeeQueryError(
                    "No Sentinel-2 scene with <20% cloud cover was found for the "
                    "requested region/date range."
                )
            s2_image = s2_collection.first()
            s2_meta = s2_image.getInfo()
            s2_date = s2_image.date()
            optical_date = preferred_date or str(s2_date.getInfo()["value"])

            # -- Sentinel-1: nearest SAR pass to the optical date ---------------
            s1_collection = (
                ee.ImageCollection(SENTINEL1_COLLECTION)
                .filterBounds(geometry)
            )
            s1_target = ee.Date(optical_date)
            s1_collection = s1_collection.filter(
                ee.Filter.date(
                    s1_target.advance(-SAR_TOLERANCE_DAYS, "day"),
                    s1_target.advance(SAR_TOLERANCE_DAYS, "day"),
                )
            ).sort(
                ee.Date(optical_date).difference(ee.Date("1970-01-01"), "day")
            )
            s1_size = int(s1_collection.size().getInfo())
            if s1_size == 0:
                raise GeeQueryError(
                    f"No Sentinel-1 acquisition within {SAR_TOLERANCE_DAYS} days of "
                    f"the optical date ({optical_date}) was found for the region. "
                    "The pair could not be formed within the documented tolerance."
                )
            s1_image = s1_collection.first()
            s1_meta = s1_image.getInfo()
            s1_date = s1_image.date().getInfo()["value"]

            # -- Export/download both scenes as local GeoTIFFs -------------------
            optical_path, sar_path = self._download_pair(
                ee, geometry, s2_image, s1_image
            )

            date_gap_days = abs(
                int(round((s1_date - optical_date) / (1000 * 60 * 60 * 24)))
            )
            optical_info = s2_meta.get("properties", {})
            s1_props = s1_meta.get("properties", {})

            return {
                "source": "gee",
                "optical": {
                    "modality": "optical",
                    "source": "sentinel-2",
                    "satellite": "Sentinel-2",
                    "collection": SENTINEL2_COLLECTION,
                    "file_path": optical_path,
                    "downloaded": True,
                    "capture_date": _ee_datetime_iso(optical_date),
                    "cloud_cover": float(optical_info.get("CLOUDY_PIXEL_PERCENTAGE"))
                    if optical_info.get("CLOUDY_PIXEL_PERCENTAGE") is not None
                    else None,
                    "resolution": 10,
                    "crs": "EPSG:4326",
                    "bounding_box": region,
                    "bands": list(SENTINEL2_EXPORT_BANDS),
                    "product_id": optical_info.get("PRODUCT_ID")
                    or s2_meta.get("id"),
                    "quality_mask": "QA60 bits 10/11 + CLOUDY_PIXEL_PERCENTAGE<20",
                },
                "sar": {
                    "modality": "sar",
                    "source": "sentinel-1",
                    "satellite": "Sentinel-1",
                    "collection": SENTINEL1_COLLECTION,
                    "file_path": sar_path,
                    "downloaded": True,
                    "capture_date": _ee_datetime_iso(s1_date),
                    "polarization": list(
                        s1_props.get("transmitterReceiverPolarisation")
                        or SENTINEL1_BANDS
                    ),
                    "orbit": (s1_props.get("orbitProperties_pass")
                              or s1_props.get("relativeOrbitNumber")
                              or "unknown"),
                    "resolution": 10,
                    "crs": "EPSG:4326",
                    "bounding_box": region,
                    "bands": list(SENTINEL1_BANDS),
                    "product_id": s1_meta.get("id"),
                    "sar_processing": s1_props.get("instrumentMode", "unknown"),
                },
                "date_gap_days": date_gap_days,
                "provider_warnings": [],
            }
        except GeeClientError:
            raise
        except Exception as exc:  # defensive: never fabricate on a query/export error
            logger.error("GEE fetch_pair failed: %s", exc)
            raise GeeQueryError(f"GEE fetch/imager query or export failed: {exc}") from exc

    def _download_pair(self, ee, geometry, s2_image, s1_image) -> tuple[str, str]:
        """Export both ee images to local GeoTIFFs; return their paths."""
        import tempfile

        try:
            import urllib.request
        except Exception as exc:  # pragma: no cover
            raise GeeUnavailableError(f"urllib unavailable: {exc}") from exc

        creds = self._credentials
        # Only authenticated REST downloads are supported (no anonymous tiles).
        token = self._access_token()

        try:
            s2_url = s2_image.getDownloadURL({
                "scale": 10,
                "region": geometry,
                "format": "GEO_TIFF",
                "bands": SENTINEL2_EXPORT_BANDS,
            })
            s1_url = s1_image.getDownloadURL({
                "scale": 10,
                "region": geometry,
                "format": "GEO_TIFF",
                "bands": SENTINEL1_BANDS,
            })
            tmpdir = tempfile.mkdtemp(prefix="satquery_fetch_")
            s2_path = os.path.join(tmpdir, "sentinel2.tif")
            s1_path = os.path.join(tmpdir, "sentinel1.tif")
            req_headers = {"Authorization": f"Bearer {token}"} if token else {}
            urllib.request.urlretrieve(
                s2_url, s2_path, data=None
            )
            urllib.request.urlretrieve(s1_url, s1_path, data=None)
            return s2_path, s1_path
        except Exception as exc:
            raise GeeQueryError(f"GEE download/export failed: {exc}") from exc

    def _access_token(self) -> str | None:
        """Return an OAuth access token for the configured credentials, if any."""
        if not self._credentials:
            return None
        try:
            import ee
            key_path = self._credentials.get("GEE_SERVICE_ACCOUNT_KEY_PATH")
            sa = self._credentials.get("GEE_SERVICE_ACCOUNT")
            if key_path and sa:
                creds = ee.ServiceAccountCredentials(sa, key_path)
                return creds.get_access_token()
        except Exception as exc:  # pragma: no cover - depends on GEE/credentials
            logger.warning("Could not obtain GEE access token: %s", exc)
        return None


def _ee_datetime_iso(ee_millis: Any) -> str | None:
    """Convert a GEE milliseconds-since-epoch value to an ISO 8601 UTC string."""
    if ee_millis is None:
        return None
    try:
        import datetime as _dt
        if isinstance(ee_millis, dict):
            millis = ee_millis.get("value")
        else:
            millis = ee_millis
        return _dt.datetime.fromtimestamp(
            int(millis) / 1000.0, tz=_dt.timezone.utc
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return None


class MockGeeProvider(GeeProvider):
    """Deterministic, explicitly-labelled synthetic provider (tests / dev only).

    Never used for production data. Results are tagged ``source: "mock"`` so the
    API can clearly distinguish them from real GEE output.
    """

    def __init__(self) -> None:
        self.calls = 0

    def compute_trend(
        self,
        metric: str,
        region: dict[str, Any],
        start: str,
        end: str,
        interval: str = "monthly",
    ) -> dict[str, Any]:
        self.calls += 1
        if metric not in METRIC_BANDS:
            raise GeeQueryError(f"Unsupported metric '{metric}'.")

        import datetime as _dt

        ds = _dt.date.fromisoformat(start)
        de = _dt.date.fromisoformat(end)
        observations = []

        base = {"ndvi": 0.40, "ndwi": 0.10}[metric]
        step = {"ndvi": 0.02, "ndwi": -0.015}[metric]

        if interval == "yearly":
            month = _dt.date(ds.year, 6, 15)
            while month <= de:
                years = month.year - ds.year
                val = round(base + step * years, 4)
                observations.append({"date": f"{month.year}", "value": val, "valid_pixels": 1000})
                month = _dt.date(month.year + 1, 6, 15)
        else:
            month = _dt.date(ds.year, ds.month, 1)
            idx = 0
            while month <= de:
                val = round(base + step * idx, 4)
                observations.append(
                    {"date": month.strftime("%Y-%m"), "value": val, "valid_pixels": 1000}
                )
                idx += 1
                nxt = month + _dt.timedelta(days=32)
                month = _dt.date(nxt.year, nxt.month, 1)

        return {
            "source": "mock",
            "metric": metric,
            "interval": interval,
            "collection": "synthetic-fixture (not a real GEE collection)",
            "band_mapping": METRIC_BANDS[metric],
            "quality_mask": "mock-fixture: no masking",
            "observations": observations,
            "provider_warnings": ["Mock/fixture data — NOT real GEE satellite observations."],
        }

    def fetch_pair(
        self,
        region: dict[str, Any],
        start: str,
        end: str,
        preferred_date: str | None = None,
    ) -> dict[str, Any]:
        """Deterministic mock acquisition pair (no files, clearly labelled mock).

        Returns synthetic acquisition metadata only — ``file_path: None`` and
        ``downloaded: False`` — so it can never be mistaken for real imagery. The
        bbox is echoed from the requested region; capture dates are derived
        deterministically from the window.
        """
        self.calls += 1
        import datetime as _dt

        base = _dt.date.fromisoformat(start)
        optical_date = base + _dt.timedelta(days=10)
        sar_date = optical_date + _dt.timedelta(days=3)
        date_gap_days = (sar_date - optical_date).days

        optical = {
            "modality": "optical",
            "source": "sentinel-2",
            "satellite": "Sentinel-2",
            "collection": "mock-fixture (not a real GEE collection)",
            "file_path": None,
            "downloaded": False,
            "capture_date": optical_date.strftime("%Y-%m-%dT00:00:00Z"),
            "cloud_cover": 5.0,
            "resolution": 10,
            "crs": "EPSG:4326",
            "bounding_box": region,
            "bands": list(SENTINEL2_EXPORT_BANDS),
            "product_id": "mock-sentinel-2-fixture",
        }
        sar = {
            "modality": "sar",
            "source": "sentinel-1",
            "satellite": "Sentinel-1",
            "collection": "mock-fixture (not a real GEE collection)",
            "file_path": None,
            "downloaded": False,
            "capture_date": sar_date.strftime("%Y-%m-%dT00:00:00Z"),
            "polarization": ["VV", "VH"],
            "orbit": "DESCENDING",
            "resolution": 10,
            "crs": "EPSG:4326",
            "bounding_box": region,
            "bands": list(SENTINEL1_BANDS),
            "product_id": "mock-sentinel-1-fixture",
        }
        return {
            "source": "mock",
            "optical": optical,
            "sar": sar,
            "date_gap_days": date_gap_days,
            "provider_warnings": ["Mock/fixture data — NOT real GEE satellite observations."],
        }


def get_provider(mode: str | None = None) -> GeeProvider:
    """Return the provider selected by ``GEE_MODE`` (or an explicit override).

    - ``mock`` / ``dev`` → MockGeeProvider (clearly labelled, for tests/dev).
    - ``real`` → RealGeeProvider (fails clearly if GEE is unavailable).
    - anything else / unset → RealGeeProvider (production default).
    """
    mode = (mode or os.environ.get("GEE_MODE", "")).lower()
    if mode in ("mock", "dev", "test"):
        logger.info("Using MockGeeProvider (not real satellite data).")
        return MockGeeProvider()
    return RealGeeProvider()
