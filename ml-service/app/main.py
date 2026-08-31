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

from app.api.validate import router as validate_router

# Load environment variables from .env if present
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

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


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "service": "satquery-ml"}
