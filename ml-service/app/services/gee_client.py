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
