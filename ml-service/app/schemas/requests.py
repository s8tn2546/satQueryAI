"""Request schemas for ML service endpoints."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ValidateRequest(BaseModel):
    modality_hint: str | None = Field(
        default=None,
        description="Optional hint: 'optical' or 'sar'. If omitted, modality is inferred from file content.",
    )


class TrendRequest(BaseModel):
    """Request body for POST /trend (historical trend analysis via GEE)."""

    region: dict[str, Any] = Field(
        ...,
        description="GeoJSON Polygon or MultiPolygon geometry for the region of interest.",
    )
    start_date: str = Field(
        ...,
        description="Start date (ISO YYYY-MM-DD), inclusive.",
    )
    end_date: str = Field(
        ...,
        description="End date (ISO YYYY-MM-DD), inclusive; must be after start_date and not in the future.",
    )
    metric: str = Field(
        default="ndvi",
        description="Remote-sensing metric: 'ndvi' (vegetation) or 'ndwi' (water).",
    )
    interval: str = Field(
        default="monthly",
        description="Temporal aggregation: 'monthly' or 'yearly'.",
    )
