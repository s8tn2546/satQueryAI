"""Request schemas for ML service endpoints."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ValidateRequest(BaseModel):
    modality_hint: str | None = Field(
        default=None,
        description="Optional hint: 'optical' or 'sar'. If omitted, modality is inferred from file content.",
    )
