"""POST /stac/search and POST /stac/ingest endpoints (STAC scene acquisition).

These endpoints power the satellite-image acquisition workflow:

- ``/stac/search`` discovers scenes matching a sensor/collection, a date
  window, an AOI and (optionally) a cloud-cover cap, through a
  :class:`SatelliteProvider`.
- ``/stac/ingest`` acquires only the requested AOI of a specific scene, persists
  a georeferenced analysis GeoTIFF plus a derived RGB preview, runs the existing
  validation pipeline, and returns the deterministic ``dedupeKey`` the backend
  tile store uses to deduplicate acquisitions.

Every response clearly distinguishes REAL STAC data from clearly-labelled test
fixtures via ``result.mock``/``metadata.reason`` and confidence. It fails
clearly (offline provider, unreachable endpoint, unsupported collection, missing
band, no AOI intersection) and never fabricates synthetic scenes or metadata.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends

from app.common.safe_errors import safe_error
from app.schemas.common import ToolOutput
from app.schemas.requests import StacIngestRequest, StacSearchRequest
from app.services.satellite_provider import (
    SatelliteProvider,
    SatelliteProviderError,
    get_provider,
)
from app.tools.stac import (
    StacToolError,
    StacValidationError,
    ingest_scene,
    search_scenes,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def resolve_provider() -> SatelliteProvider:
    """Dependency: select the provider for this request.

    Overridable in tests via FastAPI's dependency_overrides to inject a fake
    provider without touching the network.
    """
    return get_provider()


def source_warning(result: dict[str, Any]) -> str:
    if result.get("mock"):
        return (
            "Mock/fixture data — NOT real satellite imagery. No scientific "
            "claim is attached."
        )
    return "Real STAC catalog data."


@router.post("/stac/search")
async def stac_search_endpoint(
    request: StacSearchRequest,
    provider: SatelliteProvider = Depends(resolve_provider),
) -> ToolOutput:
    """Discover scenes matching a sensor/collection, date window, and AOI."""
    try:
        result = search_scenes(
            provider,
            collection=request.collection,
            sensor=request.sensor,
            aoi=request.aoi,
            aoi_crs=request.aoiCrs,
            start=request.dateRange.start,
            end=request.dateRange.end,
            cloud_max=request.cloudMax,
            limit=request.limit,
        )
    except (StacToolError, SatelliteProviderError) as exc:
        logger.warning("stac-search failed: %s", exc)
        return _failure("stac-search", safe_error(exc))
    except Exception as exc:  # pragma: no cover - defensive
        logger.error("stac-search failed unexpectedly: %s", exc)
        return _failure("stac-search", f"Internal stac-search error: {safe_error(exc)}")

    return ToolOutput(
        tool="stac-search",
        status="success",
        result=result,
        evidence={
            "source": result["source"],
            "data_source": "stac",
            "collection": result["collection"],
            "count": result["count"],
            "dateRange": result["query"]["dateRange"],
            "aoiCrs": result["query"]["aoiCrs"],
            "cloudMax": result["query"]["cloudMax"],
            "limit": result["query"]["limit"],
            "mock": result["mock"],
            "reason": result["reason"],
        },
        confidence=search_confidence(result),
        metadata={
            "provider": result["labels"],
            "mock": result["mock"],
            "reason": result["reason"],
            "source_warning": source_warning(result),
            "warnings": result["warnings"],
        },
    )


@router.post("/stac/ingest")
async def stac_ingest_endpoint(
    request: StacIngestRequest,
    provider: SatelliteProvider = Depends(resolve_provider),
) -> ToolOutput:
    """Acquire the requested AOI of a scene and persist analysis + preview."""
    try:
        result = ingest_scene(
            provider,
            collection=request.collection,
            scene_id=request.sceneId,
            aoi=request.aoi,
            aoi_crs=request.aoiCrs,
            bands=request.bands,
            target_crs=request.targetCrs,
        )
    except (StacToolError, SatelliteProviderError) as exc:
        logger.warning("stac-ingest failed: %s", exc)
        return _failure("stac-ingest", safe_error(exc))
    except Exception as exc:  # pragma: no cover - defensive
        logger.error("stac-ingest failed unexpectedly: %s", exc)
        return _failure("stac-ingest", f"Internal stac-ingest error: {safe_error(exc)}")

    return ToolOutput(
        tool="stac-ingest",
        status="success",
        result=result,
        evidence={
            "source": result["source"],
            "data_source": "stac",
            "collection": result["collection"],
            "sceneId": result["sceneId"],
            "dedupeKey": result["dedupeKey"],
            "analysisRaster": result["analysisRaster"],
            "crs": result["analysis"]["crs"],
            "bands": result["analysis"]["bands"],
            "dataset_valid": result["validation"]["valid"],
            "mock": result["mock"],
            "reason": result["reason"],
        },
        confidence=ingest_confidence(result),
        metadata={
            "provider": result["labels"],
            "mock": result["mock"],
            "reason": result["reason"],
            "source_warning": source_warning(result),
            "warnings": result["warnings"],
            "validation": {
                "status": result["validation"]["status"],
                "integrity": result["validation"]["integrity"],
            },
        },
    )


def search_confidence(result: dict[str, Any]) -> float:
    """Deterministic confidence for a search result."""
    if result.get("mock"):
        return 0.7
    if result["count"] == 0:
        return 0.8
    if result.get("warnings"):
        return 0.8
    return 1.0


def ingest_confidence(result: dict[str, Any]) -> float:
    """Deterministic confidence for an ingest result."""
    if result.get("mock"):
        return 0.7
    validation = result.get("validation", {})
    if not validation.get("valid"):
        return 0.5
    if result.get("warnings") or validation.get("warnings"):
        return 0.8
    return 1.0


def _failure(tool: str, message: str) -> ToolOutput:
    return ToolOutput(
        tool=tool,
        status="failed",
        result={"error": message},
        evidence={},
        confidence=0.0,
        metadata={},
    )