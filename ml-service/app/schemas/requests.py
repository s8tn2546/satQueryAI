"""Request schemas for ML service endpoints."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class StacDateRange(BaseModel):
    """Search window for /stac/search (ISO YYYY-MM-DD, inclusive)."""

    start: str | None = Field(
        default=None,
        description="Start date (ISO YYYY-MM-DD), inclusive.",
    )
    end: str | None = Field(
        default=None,
        description="End date (ISO YYYY-MM-DD), inclusive; must not be in the future.",
    )


class StacSearchRequest(BaseModel):
    """Request body for POST /stac/search (STAC scene discovery)."""

    sensor: str | None = Field(
        default=None,
        description="Sensor/platform family, e.g. 'sentinel-2' or 'landsat-9'.",
    )
    collection: str | None = Field(
        default=None,
        description="STAC collection ID, e.g. 'sentinel-2-l2a' or 'landsat-c2-l2'. "
        "Preferred over (and cross-checked with) `sensor`.",
    )
    dateRange: StacDateRange = Field(
        default_factory=StacDateRange,
        description="Required acquisition window searched against the catalog.",
    )
    aoi: dict[str, Any] = Field(
        ...,
        description="GeoJSON Polygon/MultiPolygon (or Feature/FeatureCollection) "
        "area of interest, interpreted per RFC 7946 (WGS84) unless `aoiCrs` is given.",
    )
    aoiCrs: str | None = Field(
        default=None,
        description="CRS of `aoi` when it is not WGS84 lon/lat; never inferred.",
    )
    cloudMax: float | None = Field(
        default=None,
        description="Maximum acceptable cloud cover (0-100). Scenes above this "
        "are excluded; scenes with no cloud metadata are kept.",
    )
    limit: int | None = Field(
        default=10,
        description="Maximum number of scenes to return (1-100).",
    )


class StacIngestRequest(BaseModel):
    """Request body for POST /stac/ingest (AOI-only scene acquisition)."""

    provider: str | None = Field(
        default=None,
        description="Informational provider override hint. The actual provider "
        "is selected by the environment (STAC_MODE); this field is recorded "
        "but never trusts credentials.",
    )
    collection: str = Field(
        ...,
        description="STAC collection ID of the scene, e.g. 'sentinel-2-l2a'.",
    )
    sceneId: str = Field(
        ...,
        description="Provider-scene id returned by /stac/search (e.g. a STAC "
        "item id). Re-resolved against the provider; never trusted verbatim.",
    )
    aoi: dict[str, Any] = Field(
        ...,
        description="GeoJSON Polygon/MultiPolygon area of interest to acquire.",
    )
    aoiCrs: str | None = Field(
        default=None,
        description="CRS of `aoi` when it is not WGS84 lon/lat; never inferred.",
    )
    bands: list[str] | None = Field(
        default=None,
        description="Internal band roles to acquire (blue, green, red, nir) or "
        "provider asset names. Defaults to blue/green/red/nir.",
    )
    targetCrs: str | None = Field(
        default=None,
        description="Requested output CRS. Must equal the scene's native CRS; "
        "reprojection is not yet supported and a mismatch fails explicitly.",
    )


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
    aoi: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Optional GeoJSON Polygon/MultiPolygon analysis-of-interest, applied as "
            "an intersection with `region`. When present the series is computed "
            "over region-aoi only, and the applied scope is reported in the "
            "result's `aoiScope` block."
        ),
    )
    aoi_crs: str | None = Field(
        default=None,
        description=(
            "CRS of `aoi` when it is not WGS84 lon/lat. Reprojected to EPSG:4326 "
            "before use. Never inferred."
        ),
    )


class FetchImageryRequest(BaseModel):
    """Request body for POST /fetch-imagery (region-based imagery acquisition)."""

    bounding_box: dict[str, Any] = Field(
        ...,
        description="GeoJSON Polygon or MultiPolygon bounding box for the region of interest.",
    )
    start_date: str | None = Field(
        default=None,
        description="Optional start date (ISO YYYY-MM-DD) of the search window.",
    )
    end_date: str | None = Field(
        default=None,
        description="Optional end date (ISO YYYY-MM-DD) of the search window; default ends today.",
    )
    preferred_date: str | None = Field(
        default=None,
        description="Optional preferred acquisition date (ISO YYYY-MM-DD) used as the SAR-pass anchor.",
    )
