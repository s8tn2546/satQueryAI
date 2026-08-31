"""Shared Pydantic models used across the ML service."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class ValidationStatus(str, Enum):
    VALID = "valid"
    WARNING = "warning"
    INVALID = "invalid"


class Modality(str, Enum):
    OPTICAL = "optical"
    SAR = "sar"
    UNKNOWN = "unknown"


class BandInfo(BaseModel):
    index: int
    description: str = ""
    detected_name: str = ""
    wavelength: str = ""


class Bounds(BaseModel):
    west: float
    south: float
    east: float
    north: float


class Resolution(BaseModel):
    x: float = Field(description="Pixel width in CRS units")
    y: float = Field(description="Pixel height in CRS units (usually negative)")


class ValidateResult(BaseModel):
    valid: bool
    validation_status: ValidationStatus
    modality: Modality = Modality.UNKNOWN
    format: str = ""
    width: int = 0
    height: int = 0
    band_count: int = 0
    bands: list[BandInfo] = []
    crs: str | None = None
    bounds: Bounds | None = None
    wgs84_bounds: Bounds | None = None
    resolution: Resolution | None = None
    nodata: Any = None
    dtype: str = ""
    warnings: list[str] = []
    errors: list[str] = []


class ToolOutput(BaseModel):
    tool: str
    status: str = "success"
    result: dict[str, Any] = Field(default_factory=dict)
    evidence: dict[str, Any] = Field(default_factory=dict)
    confidence: float = 0.0
    metadata: dict[str, Any] = Field(default_factory=dict)
