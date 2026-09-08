"""SatQuery AI — ML / Geospatial Service.

FastAPI application entry point. This service handles all raster
processing, geospatial computation, and ML inference for the
SatQuery AI system.
"""

from __future__ import annotations

import logging
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Load environment variables from .env BEFORE importing router modules so that
# module-level env reads at import time (VQA_ADAPTER_PATH, CAPTION_ADAPTER_PATH,
# VLM_MODEL, ...) observe .env values instead of being captured too early.
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

from app.api.area import router as area_router
from app.api.caption import router as caption_router
from app.api.change import router as change_router
from app.api.fetch_imagery import router as fetch_imagery_router
from app.api.ndvi import router as ndvi_router
from app.api.ndwi import router as ndwi_router
from app.api.optical_sar import router as optical_sar_router
from app.api.trend import router as trend_router
from app.api.validate import router as validate_router
from app.api.vqa import router as vqa_router

logging.basicConfig(
    level=logging.INFO,
    format="[%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="SatQuery ML Service",
    description=(
        "ML and Geospatial service for SatQuery AI. "
        "Handles raster I/O, image validation, metadata extraction, "
        "and all geospatial computation."
    ),
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(validate_router, tags=["validation"])
app.include_router(vqa_router, tags=["vlm"])
app.include_router(caption_router, tags=["vlm"])
app.include_router(ndvi_router, tags=["spectral-index"])
app.include_router(ndwi_router, tags=["spectral-index"])
app.include_router(area_router, tags=["geospatial"])
app.include_router(change_router, tags=["change-detection"])
app.include_router(optical_sar_router, tags=["fusion"])
app.include_router(trend_router, tags=["trend-analysis"])
app.include_router(fetch_imagery_router, tags=["imagery-acquisition"])


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "service": "satquery-ml"}
