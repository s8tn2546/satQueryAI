"""POST /trend endpoint (historical trend analysis via Google Earth Engine).

Accepts a JSON body describing a region, date range and remote-sensing metric,
queries a GEE data provider for historical observations, and returns a time
series plus deterministic trend statistics in the standard tool output schema.

This endpoint always distinguishes REAL GEE data from MOCK/test fixtures via
``metadata.data_source`` (and confidence). It fails clearly when real GEE is
required but unavailable — it never fabricates satellite observations.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends

from app.schemas.common import ToolOutput
from app.schemas.requests import TrendRequest
from app.services.gee_client import (
    GeeClientError,
    GeeProvider,
    get_provider,
)
from app.tools.trend import (
    TrendComputationError,
    TrendError,
    TrendValidationError,
    compute_trend,
    trend_confidence,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def resolve_provider() -> GeeProvider:
    """Dependency: select the provider for this request.

    Overridable in tests via FastAPI's dependency_overrides to inject a fake
    provider without touching the network.
    """
    return get_provider()


@router.post("/trend")
async def trend_endpoint(
    request: TrendRequest,
    provider: GeeProvider = Depends(resolve_provider),
) -> ToolOutput:
    """Compute a historical time series and trend for a region/metric."""
    try:
        result = compute_trend(
            provider,
            metric=request.metric,
            region=request.region,
            start_date=request.start_date,
            end_date=request.end_date,
            interval=request.interval,
        )
    except TrendValidationError as exc:
        return _failure(str(exc))
    except (GeeClientError,) as exc:
        return _failure(
            "Historical trend could not use real GEE data: " + str(exc)
        )
    except TrendComputationError as exc:
        return _failure(str(exc))
    except TrendError as exc:
        return _failure(str(exc))
    except Exception as exc:  # pragma: no cover - defensive
        logger.error("Trend computation failed unexpectedly: %s", exc)
        return _failure(f"Internal trend error: {exc}")

    source = result.get("source", "unknown")
    return ToolOutput(
        tool="trend",
        status="success",
        result=result,
        evidence={
            "metric": result.get("metric"),
            "region": result.get("region"),
            "date_range": result.get("date_range"),
            "interval": result.get("interval"),
            "collection": result.get("collection"),
            "quality_mask": result.get("quality_mask"),
            "observation_count": result.get("trend", {}).get("observation_count"),
            "data_source": source,
        },
        confidence=trend_confidence(result),
        metadata={
            "data_source": source,
            "band_mapping": result.get("band_mapping"),
            "source_warning": (
                "Mock/fixture data. Not real GEE satellite observations."
                if source != "gee"
                else "Real Google Earth Engine data."
            ),
            "input_start": request.start_date,
            "input_end": request.end_date,
        },
    )


def _failure(message: str) -> ToolOutput:
    return ToolOutput(
        tool="trend",
        status="failed",
        result={"error": message},
        evidence={},
        confidence=0.0,
        metadata={},
    )
