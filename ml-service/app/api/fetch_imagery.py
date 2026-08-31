"""POST /fetch-imagery endpoint (region-based imagery acquisition via Google Earth Engine).

Accepts a JSON body describing a geographic bounding box and an optional date window,
fetches a co-registered optical (Sentinel-2) + SAR (Sentinel-1) pair through a GEE
provider, runs any downloaded rasters through the validation pipeline, and returns
standard tool output.

This endpoint always distinguishes REAL GEE data from MOCK/test fixtures via
``metadata.data_source`` and confidence. It fails clearly when real GEE is required
but unavailable — it never fabricates imagery.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends

from app.schemas.common import ToolOutput
from app.schemas.requests import FetchImageryRequest
from app.services.gee_client import (
    GeeClientError,
    GeeProvider,
    get_provider,
)
from app.tools.fetch_imagery import (
    FetchImageryError,
    FetchNoImageError,
    FetchValidationError,
    fetch_confidence,
    fetch_imagery,
    fetch_status,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def resolve_provider() -> GeeProvider:
    """Dependency: select the provider for this request.

    Overridable in tests via FastAPI's dependency_overrides to inject a fake
    provider without touching the network.
    """
    return get_provider()


@router.post("/fetch-imagery")
async def fetch_imagery_endpoint(
    request: FetchImageryRequest,
    provider: GeeProvider = Depends(resolve_provider),
) -> ToolOutput:
    """Fetch a co-registered optical + SAR pair for a region/window."""
    try:
        result = fetch_imagery(
            provider,
            bounding_box=request.bounding_box,
            start_date=request.start_date,
            end_date=request.end_date,
            preferred_date=request.preferred_date,
        )
    except FetchValidationError as exc:
        return _failure(str(exc))
    except FetchNoImageError as exc:
        return _failure(str(exc))
    except (GeeClientError,) as exc:
        return _failure(
            "Imagery acquisition could not use real GEE data: " + str(exc)
        )
    except FetchImageryError as exc:
        return _failure(str(exc))
    except Exception as exc:  # pragma: no cover - defensive
        logger.error("fetch-imagery failed unexpectedly: %s", exc)
        return _failure(f"Internal fetch-imagery error: {exc}")

    source = result.get("source", "unknown")
    return ToolOutput(
        tool="fetch-imagery",
        status=fetch_status(result),
        result={
            "images": result.get("images"),
            "date_gap_days": result.get("date_gap_days"),
            "bounding_box": result.get("bounding_box"),
            "date_range": result.get("date_range"),
            "source": source,
            "warnings": result.get("warnings"),
        },
        evidence={
            "region": result.get("bounding_box"),
            "date_range": result.get("date_range"),
            "date_gap_days": result.get("date_gap_days"),
            "satellites": [i.get("source") for i in result.get("images", [])],
            "data_source": source,
        },
        confidence=fetch_confidence(result),
        metadata={
            "data_source": source,
            "date_gap_days": result.get("date_gap_days"),
            "source_warning": (
                "Mock/fixture data. Not real GEE satellite imagery."
                if source != "gee"
                else "Real Google Earth Engine imagery."
            ),
            "input_start": request.start_date,
            "input_end": request.end_date,
            "preferred_date": request.preferred_date,
        },
    )


def _failure(message: str) -> ToolOutput:
    return ToolOutput(
        tool="fetch-imagery",
        status="failed",
        result={"error": message},
        evidence={},
        confidence=0.0,
        metadata={},
    )
