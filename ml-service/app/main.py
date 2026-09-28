"""SatQuery AI — ML / Geospatial Service.

FastAPI application entry point. This service handles all raster
processing, geospatial computation, and ML inference for the
SatQuery AI system.

Hardening notes
---------------
- CORS is allowlist-only: allowed origins come from the ``CORS_ORIGINS`` env
  (comma-separated); a wildcard is never accepted, so ``allow_credentials``
  stays off.
- Security response headers are applied by middleware (nosniff, DENY framing,
  restrictive referrer/permissions policies).
- ``ALLOWED_HOSTS`` (comma-separated) enables an optional TrustedHost guard.
- ``ML_RATE_LIMIT_ENABLED`` enables an in-memory sliding-window rate limit
  (``ML_RATE_LIMIT_MAX`` requests per ``ML_RATE_LIMIT_WINDOW`` seconds). It is
  opt-in and off by default.
"""

from __future__ import annotations

import logging
import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse

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
from app.api.stac import router as stac_router
from app.api.trend import router as trend_router
from app.api.validate import router as validate_router
from app.api.vqa import router as vqa_router

logging.basicConfig(
    level=logging.INFO,
    format="[%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Configuration (all operator-controlled, never hard-coded secrets)            #
# --------------------------------------------------------------------------- #

# Default dev frontend ports. Override in production with CORS_ORIGINS.
_DEFAULT_CORS_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
)


def _cors_origins() -> list[str]:
    raw = os.environ.get("CORS_ORIGINS", "").strip()
    if not raw:
        return list(_DEFAULT_CORS_ORIGINS)
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    if "*" in origins:
        # A wildcard with credentials is never allowed; drop it silently.
        origins = [o for o in origins if o != "*"]
        logger.warning("CORS_ORIGINS contained '*'; wildcard origins are not allowed.")
    return origins


def _bool_env(key: str, *, default: bool = False) -> bool:
    return os.environ.get(key, "").strip().lower() in {"1", "true", "yes", "on"}


def _int_env(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, "").strip())
    except ValueError:
        return default


CORS_ALLOWED_ORIGINS = _cors_origins()
TRUSTED_HOSTS = [
    h.strip() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()
]
RATE_LIMIT_ENABLED = _bool_env("ML_RATE_LIMIT_ENABLED")
RATE_LIMIT_MAX = max(_int_env("ML_RATE_LIMIT_MAX", 60), 1)
RATE_LIMIT_WINDOW = max(_int_env("ML_RATE_LIMIT_WINDOW", 60), 1)

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


def _warn_once(message: str) -> None:
    logger.warning(message)


def _log_config_warnings() -> None:
    """Warn-only operator checklist. Never blocks startup; never aborts tests."""
    if RATE_LIMIT_ENABLED:
        logger.info(
            "Rate limiting enabled: %s req / %ss per client IP.",
            RATE_LIMIT_MAX,
            RATE_LIMIT_WINDOW,
        )
    if TRUSTED_HOSTS:
        logger.info("Trusted hosts restricted to: %s", ", ".join(TRUSTED_HOSTS))

    vqa_adapter = os.environ.get("VQA_ADAPTER_PATH", "").strip()
    if vqa_adapter and not Path(vqa_adapter).exists():
        _warn_once(
            "VQA_ADAPTER_PATH is set but the directory does not exist on disk "
            "(%s); VQA will run WITHOUT a LoRA adapter.",
            vqa_adapter,
        )
    caption_adapter = os.environ.get("CAPTION_ADAPTER_PATH", "").strip()
    if caption_adapter and not Path(caption_adapter).exists():
        _warn_once(
            "CAPTION_ADAPTER_PATH is set but the directory does not exist on disk "
            "(%s); captioning will run WITHOUT a LoRA adapter.",
            caption_adapter,
        )

    if os.environ.get("GEE_MODE", "").strip().lower() not in ("mock", "dev", "test"):
        if not any(
            os.environ.get(k)
            for k in ("GEE_PROJECT_ID", "GEE_SERVICE_ACCOUNT", "GEE_SERVICE_ACCOUNT_KEY_PATH")
        ):
            _warn_once(
                "GEE credentials are not configured; /trend and /fetch-imagery "
                "will fail clearly when asked for real GEE data."
            )

    if not os.environ.get("STAC_API_URL", "").strip():
        _warn_once(
            "STAC_API_URL is not configured; /stac/* will use the offline "
            "provider (no synthetic data is ever fabricated)."
        )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _log_config_warnings()
    yield


app = FastAPI(
    title="SatQuery ML Service",
    description=(
        "ML and Geospatial service for SatQuery AI. "
        "Handles raster I/O, image validation, metadata extraction, "
        "and all geospatial computation."
    ),
    version="0.1.0",
    lifespan=lifespan,
)

# Middlewares are applied in reverse order of registration: the LAST middleware
# registered runs FIRST on the way in. CORS is therefore registered last so it
# sits outermost and stamps headers on every response, including those produced
# by inner middleware (rate limits, security headers).


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    for key, value in SECURITY_HEADERS.items():
        response.headers.setdefault(key, value)
    return response


if RATE_LIMIT_ENABLED:
    _hit_times: dict[str, deque] = defaultdict(deque)

    @app.middleware("http")
    async def enforce_rate_limit(request: Request, call_next):
        if request.url.path == "/health":
            return await call_next(request)
        client = request.client.host if request.client is not None else "unknown"
        now = time.monotonic()
        hits = _hit_times[client]
        while hits and hits[0] <= now - RATE_LIMIT_WINDOW:
            hits.popleft()
        if len(hits) >= RATE_LIMIT_MAX:
            return JSONResponse(
                status_code=429,
                content={"error": "Rate limit exceeded. Try again shortly."},
            )
        hits.append(now)
        return await call_next(request)


if TRUSTED_HOSTS:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=TRUSTED_HOSTS)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=False,
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
app.include_router(stac_router, tags=["stac-acquisition"])


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "service": "satquery-ml"}