# SatQuery AI — ML / Geospatial Service

The **ML and Geospatial service** for the SatQuery AI project. This FastAPI-based
Python service is where all pixel-level work happens: reading rasters, validating
images, and (in later milestones) computing NDVI/NDWI, change detection, optical+SAR
fusion, etc.

**Important architectural rule:** this service never talks to the frontend directly
and never decides which tool to call — that is the Node.js backend's job (see
`backend/BACKEND.md`). This service exposes narrow, well-defined HTTP endpoints and
does the actual work when the backend calls them.

---

## Milestone 1 scope — what this currently does

This is **Milestone 1: the foundation**. It implements:

| Capability | Status |
|---|---|
| FastAPI application + `/health` | ✅ Done |
| `/validate` endpoint | ✅ Done |
| Raster I/O (GeoTIFF/TIFF via rasterio) | ✅ Done |
| PNG/JPEG support (via rasterio/Pillow) | ✅ Done |
| Metadata extraction (CRS, bounds, resolution, bands, nodata) | ✅ Done |
| CRS handling + WGS84 conversion (pyproj) | ✅ Done |
| Band detection (from explicit metadata only) | ✅ Done |
| Basic preprocessing utilities (normalization) | ✅ Done |
| Image validation pipeline | ✅ Done |
| Unit tests using synthetic rasters | ✅ Done |
| Dockerfile | ✅ (not built in this environment) |

**Not yet implemented** (later milestones): NDVI, NDWI, area calculation, change
detection, optical+SAR fusion, trend analysis, Google Earth Engine, VQA/captioning/
grounding, model training, LoRA adaptation, image acquisition (`/fetch-imagery`).

---

## Architecture

```
POST /validate  ──▶  app/api/validate.py     (HTTP layer, file upload handling)
                        │
                        ▼
                     app/geospatial/validation.py   (validation pipeline, the core)
                        │
        ┌───────────────┼───────────────────┐
        ▼               ▼                   ▼
 app/geospatial/  app/preprocessing/   app/schemas/
 raster_io.py     loader.py             common.py
 crs.py           band_detection.py     requests.py
                  normalize.py
```

- **`app/geospatial/`** — raster I/O, CRS handling, and the validation pipeline.
- **`app/preprocessing/`** — image loading, band detection, normalization.
- **`app/api/`** — FastAPI route definitions.
- **`app/schemas/`** — Pydantic request/response models.

The module responsibilities are kept small and focused. Later milestones add new
files under `app/tools/` and `app/api/` without rewriting this foundation.

---

## Prerequisites

- **Python 3.11+** (this was developed and tested on 3.14)
- `git`

The heavy ML libraries (PyTorch, Transformers, Earth Engine) are **not** needed for
Milestone 1.

---

## Setup

### 1. Create a virtual environment

Always use a virtual environment so you don't pollute your global Python.

```bash
cd ml-service
python3 -m venv .venv
```

### 2. Activate it

```bash
# macOS / Linux
source .venv/bin/activate

# Windows (PowerShell)
.venv\Scripts\activate
```

Your prompt should now show `(.venv)` at the start.

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

This installs FastAPI, Uvicorn, Pydantic, rasterio, NumPy, pyproj, Shapely,
Pillow, and python-dotenv.

### 4. (Optional) Environment variables

Copy the example file:

```bash
cp .env.example .env
```

The current Milestone 1 needs no secrets. The defaults (`PORT=8000`,
`HOST=0.0.0.0`) are used by the run script below. Later milestones will add
Google Earth Engine and model credentials — **don't add fake keys now**.

---

## Running locally

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Or, to use the `PORT`/`HOST` from `.env`:

```bash
source .env
uvicorn app.main:app --host "$HOST" --port "$PORT"
```

You should see a message like:

```
INFO:     Uvicorn running on http://0.0.0.0:8000
```

Once running, you can open the interactive API docs at:
[http://localhost:8000/docs](http://localhost:8000/docs)

---

## Health check

```
GET /health
```

Response:

```json
{
  "status": "ok",
  "service": "satquery-ml"
}
```

---

## Validate endpoint

```
POST /validate
```

Accepts a **multipart/form-data** file upload. Form fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | yes | The image/raster to validate |
| `modality_hint` | string | no | Optional: `optical` or `sar` |

### Example using curl

```bash
curl -X POST http://localhost:8000/validate \
  -F "file=@path/to/image.tif" \
  -F "modality_hint=optical"
```

### Example response

```json
{
  "tool": "validate",
  "status": "success",
  "result": {
    "valid": true,
    "validation_status": "valid",
    "modality": "optical",
    "format": "GTiff",
    "width": 1024,
    "height": 1024,
    "band_count": 4,
    "bands": [
      { "index": 1, "description": "red",   "detected_name": "red",   "wavelength": "" },
      { "index": 2, "description": "green", "detected_name": "green", "wavelength": "" },
      { "index": 3, "description": "blue",  "detected_name": "blue",  "wavelength": "" },
      { "index": 4, "description": "nir",   "detected_name": "nir",   "wavelength": "" }
    ],
    "crs": "EPSG:32643",
    "bounds": { "west": 500000.0, "south": 4599900.0, "east": 500100.0, "north": 4600000.0 },
    "wgs84_bounds": { "west": 75.0, "south": 41.55, "east": 75.001, "north": 41.552 },
    "resolution": { "x": 10.0, "y": 10.0 },
    "nodata": null,
    "dtype": "uint8",
    "warnings": [],
    "errors": []
  },
  "evidence": { "filename": "image.tif" },
  "confidence": 1.0,
  "metadata": { "filename": "image.tif", "size_bytes": 1234 }
}
```

### Validation states

The `result.validation_status` is one of:

| Status | Meaning | Example |
|---|---|---|
| `valid` | Fully usable | A clean, georeferenced, correctly-sized raster |
| `warning` | Usable but with caveats | Missing CRS/geotransform, unknown bands |
| `invalid` | Not usable | Corrupt file, unsupported format, all-nodata, empty |

`confidence` is derived from the validation state: `1.0` for valid, `0.7` for
warning, `0.0` for invalid. It is never random.

---

## Supported input types

| Type | Notes |
|---|---|
| **GeoTIFF / TIFF** (`*.tif`, `*.tiff`) | Full geospatial metadata extraction. This is the primary format. |
| **PNG** (`*.png`) | Supported. Usually not georeferenced — CRS/bounds will be `null`. |
| **JPEG** (`*.jpg`, `*.jpeg`) | Supported. Same georeferencing caveat as PNG. |

**Important:** this service never invents geospatial metadata. If an image has no
CRS or transform, the response reports `crs: null`, `bounds: null`, and adds a
warning. It does not guess.

---

## Testing

The tests use **synthetic rasters** created in memory/temp files (via rasterio and
Pillow) — no external satellite datasets needed.

```bash
python -m pytest -v
```

This runs:

- `test_raster_io.py` — opening rasters, reading metadata, bands, bounds, resolution
- `test_validation.py` — the validation pipeline across valid/corrupt/no-CRS/nodata cases
- `test_band_detection.py` — band identity inference and modality detection
- `test_validate_api.py` — the `/health` and `/validate` HTTP endpoints

The tests are deterministic — they should pass every time.

---

## Running with Docker

```bash
# Build the image
docker build -t satquery-ml .

# Run it
docker run -p 8000:8000 satquery-ml
```

The Dockerfile uses a `python:3.11-slim` base, installs the requirements, and runs
Uvicorn on port 8000.

**Note:** no `docker-compose` file is included yet — that belongs to the final
integration milestone, when the Node backend and ML service are orchestrated together.

---

## Limitations (Milestone 1)

- Band detection only reads **explicit** band metadata/descriptions present in the
  file. It does **not** guess band meaning from band position (e.g. it won't assume
  "band 1 = red") — this is intentional and avoids hardcoding source-specific
  assumptions (Sentinel-2 vs Cartosat-2S vs RISAT slicing).
- Modality is inferred only from band metadata or an explicit `modality_hint`.
  A single unlabeled band reports `"unknown"` modality (honest, not assumed).
- No NDVI/NDWI/change/fusion/trend yet — those come in later milestones.
- The `/validate` endpoint does **not** store the uploaded file permanently; it
  writes to a temp file, validates, then deletes it.

---

## Project conventions

Follow the existing project structure and response contracts:

- `backend/BACKEND.md` — authoritative backend spec (the agent/orchestrator).
- `ml/ML_SERVICE.md` — authoritative ML-service spec. **If this file conflicts
  with anything in this README, `ML_SERVICE.md` wins.**
- The standard tool output schema (`tool`, `status`, `result`, `evidence`,
  `confidence`, `metadata`) is defined in `app/schemas/common.py` and is used by
  the `/validate` response so the backend can assemble evidence/confidence/trace
  uniformly.
