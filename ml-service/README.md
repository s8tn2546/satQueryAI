# SatQuery AI — ML / Geospatial Service

The **ML and Geospatial service** for the SatQuery AI project. This FastAPI-based
Python service is where all pixel-level work happens: reading rasters, validating
images, and computing NDVI/NDWI/area. (Later milestones add change detection,
optical+SAR fusion, etc.)

**Important architectural rule:** this service never talks to the frontend directly
and never decides which tool to call — that is the Node.js backend's job (see
`backend/BACKEND.md`). This service exposes narrow, well-defined HTTP endpoints and
does the actual work when the backend calls them.

---

## Milestone 1 + 2 + 3 + 4 scope — what this currently does

This implements **Milestone 1 (foundation)**, **Milestone 2 (geospatial tools)**,
**Milestone 3 (bi-temporal change detection)**, and **Milestone 4 (optical+SAR
fusion / cross-modal analysis)**:

| Capability | Status |
|---|---|
| FastAPI application + `/health` | ✅ Done |
| `/validate` endpoint | ✅ Done |
| `/ndvi` endpoint (Normalized Difference Vegetation Index) | ✅ Done |
| `/ndwi` endpoint (Normalized Difference Water Index) | ✅ Done |
| `/area` endpoint (surface area from valid pixels) | ✅ Done |
| `/change` endpoint (bi-temporal change detection) | ✅ Done |
| `/optical-sar` endpoint (optical + SAR cross-modal analysis) | ✅ Done |
| Raster I/O (GeoTIFF/TIFF via rasterio) | ✅ Done |
| PNG/JPEG support (via rasterio/Pillow) | ✅ Done |
| Metadata extraction (CRS, bounds, resolution, bands, nodata) | ✅ Done |
| CRS handling + WGS84 conversion (pyproj) | ✅ Done |
| Band detection + modality detection (from explicit metadata only) | ✅ Done |
| Basic preprocessing utilities (normalization, speckle filter) | ✅ Done |
| Image validation pipeline | ✅ Done |
| Pair validation + safe co-registration (rasterio reprojection) | ✅ Done |
| Change statistics + confidence | ✅ Done |
| Optical+SAR alignment, speckle filtering, fusion stats + confidence | ✅ Done |
| Unit tests using synthetic rasters | ✅ Done |
| Dockerfile | ✅ (not built in this environment) |

**Not yet implemented** (later milestones): trend analysis, Google Earth Engine,
VQA/captioning/grounding, model training, LoRA adaptation, image acquisition
(`/fetch-imagery`). Semantic interpretation of cross-modal evidence is the
Agent / VLM / ML layer's job (Member 5), **not** this service.

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

POST /ndvi  ──▶  app/api/ndvi.py  ──▶  app/tools/ndvi.py
POST /ndwi  ──▶  app/api/ndwi.py  ──▶  app/tools/ndwi.py
POST /area  ──▶  app/api/area.py  ──▶  app/tools/area.py
                    └──── app/tools/{band_utils,index_utils}.py

POST /change ──▶ app/api/change.py ──▶  app/tools/change.py
                    └── pair validation + deterministic alignment
                        (rasterio reproject onto image1 grid)

POST /optical-sar ──▶ app/api/optical_sar.py ──▶ app/tools/fusion.py
                    └── modality + CRS + overlap validation
                        └── SAR reprojected onto optical grid
                            └── optical NDVI/band feature + SAR speckle filter
                                └── joint overlap statistics + fusion
```

- **`app/geospatial/`** — raster I/O, CRS handling, and the validation pipeline.
- **`app/preprocessing/`** — image loading, band detection, normalization, speckle filtering.
- **`app/tools/`** — the actual computation (NDVI, NDWI, area, change, fusion) plus
  shared band-resolution, index, and alignment utilities.
- **`app/api/`** — FastAPI route definitions.
- **`app/schemas/`** — Pydantic request/response models.

The module responsibilities are kept small and focused.

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

## NDVI endpoint

```
POST /ndvi
```

**NDVI** (Normalized Difference Vegetation Index) measures vegetation vigor:

```
NDVI = (NIR - RED) / (NIR + RED)
```

Values range from -1 to +1 (healthy dense vegetation is high positive).

Form fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | yes | Multispectral raster (must expose RED + NIR bands) |
| `red_band` | int | no | Explicit 1-based RED band index (skips auto-detection) |
| `nir_band` | int | no | Explicit 1-based NIR band index (skips auto-detection) |

```bash
curl -X POST http://localhost:8000/ndvi \
  -F "file=@multispectral.tif"
```

`result` includes `min`, `max`, `mean`, `median`, `valid_pixel_count`,
`total_pixel_count`, `bands` (which indices were used), and `warnings`.

**Band detection rule:** RED/NIR are located **only** from explicit band
descriptions in the file's metadata (e.g. a band literally named `red` or `nir`).
The service never assumes a band's identity from its position. If RED/NIR cannot
be identified, the endpoint returns a structured failure (`status: "failure"`)
rather than guessing.

---

## NDWI endpoint

```
POST /ndwi
```

**NDWI** (Normalized Difference Water Index) highlights open water:

```
NDWI = (GREEN - NIR) / (GREEN + NIR)
```

Form fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | yes | Multispectral raster (must expose GREEN + NIR bands) |
| `green_band` | int | no | Explicit 1-based GREEN band index (skips auto-detection) |
| `nir_band` | int | no | Explicit 1-based NIR band index (skips auto-detection) |

```bash
curl -X POST http://localhost:8000/ndwi \
  -F "file=@multispectral.tif"
```

The same band-detection rule applies as NDVI: GREEN/NIR must be identifiable from
explicit metadata, otherwise a structured failure is returned.

---

## Area endpoint

```
POST /area
```

Computes the surface area covered by **valid (non-nodata) pixels** in a raster:

```
area = valid_pixel_count × pixel_area     (pixel_area = res_x × res_y)
```

Form fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | yes | Georeferenced raster in a **projected** CRS |
| `feature_type` | string | no | Label for the feature being measured (e.g. `water`, `deforested`) |

```bash
curl -X POST http://localhost:8000/area \
  -F "file=@scene.tif" \
  -F "feature_type=water"
```

`result` includes `area_m2`, `area_km2`, `area_ha`, `valid_pixel_count`,
`total_pixel_count`, `resolution_m`, `crs`, `pixel_area_m2`, and `warnings`.

**CRS rule:** resolution is always read from the image's actual metadata (never
assumed). Because `deg × deg` is not a real area, images in a **geographic**
(degree-based) CRS such as EPSG:4326 return a structured failure explaining that
they must first be reprojected to a projected CRS (e.g. UTM) — the service does
not invent a wrong number.

---

## Change Detection endpoint

```
POST /change
```

**Change detection** compares two images of the same area from different dates and
reports where meaningful change occurred. The baseline method is an **absolute pixel
difference**: `diff = |image2 − image1|`, with pixels where `diff > threshold`
classified as changed.

Conceptual pipeline: validate each image → check compatibility (CRS / dimensions /
bounds / resolution / overlap) → align if safely possible → pick a comparison band
→ absolute difference → change mask → statistics → evidence.

Form fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `image1` | file | yes | First image (earlier / time 1) |
| `image2` | file | yes | Second image (later / time 2) |
| `threshold` | float | no | Change threshold in data units; ≥ 0. See defaults below. |
| `band` | int | no | Explicit 1-based band index to compare in **both** images |
| `band_t1` | int | no | Explicit 1-based band index in image1 (must be given with `band_t2`) |
| `band_t2` | int | no | Explicit 1-based band index in image2 |

```bash
curl -X POST http://localhost:8000/change \
  -F "image1=@time1.tif" \
  -F "image2=@time2.tif" \
  -F "threshold=50"
```

`result` includes: `method`, `comparison_band`, `threshold` / `threshold_source`,
`total_pixels`, `valid_pixels`, `invalid_pixels`, `changed_pixels`,
`unchanged_pixels`, `change_percentage`, `mean_difference`, `max_difference`,
`changed_area_km2`, `aligned`, `alignment` (`direct` or `reprojected`), and
`warnings`.

### Threshold

- If `threshold` is supplied, it is used directly (must be ≥ 0).
- If omitted, a **documented deterministic default** is used: **two standard
  deviations (`2σ`) of the valid pixel differences** — a standard statistical
  change-detection baseline (reported as `threshold_source: "auto_2sigma"`). It
  is never random.

### Band selection (never guesses positions)

Priority order: explicit `band` → explicit `band_t1`/`band_t2` → both images are
single-band (compare band 1, a data comparison) → a band name explicitly present
in **both** images' descriptions → otherwise an honest **failure** explaining that
no comparison band could be chosen. The service never assumes band 1 = red, etc.

### Safe alignment / co-registration

- Same CRS + same dimensions + compatible transform + overlapping bounds → compared
  **directly** (`alignment: "direct"`, confidence 1.0).
- If the grids or CRSs differ but the images overlap, image2 is deterministically
  reprojected onto image1's grid using `rasterio.warp.reproject` with
  `Resampling.nearest` (never invents values) and `dst_nodata=nan` so pixels outside
  the overlap are excluded, never counted as change.
- If reliable alignment/overlap **cannot** be established, the endpoint returns a
  structured failure (`status: "failure"`, `confidence: 0.0`) rather than a fake
  result.

### Incompatibility & failures

Incompatible pairs fail safely (never fabricate a change result): missing/invalid
file, non-overlapping bounds, mixed georeferencing (one georeferenced, one not),
mismatched non-georeferenced dimensions, all-nodata input, undeterminable band, or
invalid threshold. Failures return `status: "failure"` with `confidence: 0.0` and a
clear `result.error` explanation.

### Nodata / NaN / Inf

Raster nodata, NaN, and infinite pixels are excluded from statistics and can never
be classified as change. Only valid (finite, non-nodata, overlapping) pixels are
counted; counts of `total` / `valid` / `invalid` / `changed` / `unchanged` are
reported.

### Confidence (deterministic)

- `1.0` — direct comparison, both images valid, compatible, no warnings.
- `0.8` — reprojection/alignment required, or other warnings present, but valid
  pixels exist.
- `0.0` — validation/alignment failure or no valid pixels.
  Derived from result reliability only — never random.

---

## Optical + SAR Fusion endpoint

```
POST /optical-sar
```

**Cross-modal analysis** combines an optical image with a SAR image of the same area
and returns **quantitative, complementary evidence** — it does **not** make semantic
claims ("flood occurred", "deforestation", etc.). Interpretation is handled later by
the Agent / VLM / ML layer.

Form fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `optical_image` | file | yes | Optical (multispectral / RGB) raster |
| `sar_image` | file | yes | SAR raster (e.g. single-band backscatter, VV/VH) |
| `optical_band` | int | no | Explicit 1-based optical band to use as the feature |
| `sar_band` | int | no | Explicit 1-based SAR band to analyze |
| `speckle_size` | int | no | Speckle-filter window (odd ≥ 1); default 3 |

```bash
curl -X POST http://localhost:8000/optical-sar \
  -F "optical_image=@optical.tif" \
  -F "sar_image=@sar.tif"
```

`result` structure:

- **`optical`** — feature basis (`ndvi ...` or `band n`) and statistics (mean, median,
  min, max, std, count) plus a normalized `[0,1]` mean.
- **`sar`** — analyzed band, its statistics, the deterministic speckle filter applied
  (`median`, window size), and a normalized mean.
- **`fusion`** — a documented **equal-weight feature-level fusion** (`0.5 × optical
  normalized + 0.5 × SAR normalized`): combined mean/std and per-pixel Pearson
  correlation (when computable).
- **`overlap`** — `total_pixels`, `valid_pixels`, `invalid_pixels`,
  `validation_ratio`, `valid_area_km2` (projected CRS only), `partial`,
  `overlap_ratio`.
- **`alignment`** — `direct` or `reprojected` (+ resampling).
- **`crs`** — optical/SAR labels and whether they match.
- **`warnings`** — honest caveats (unknown modality, reprojection, partial overlap, etc.).

### How a feature is chosen (never guesses positions)

Optical feature precedence: explicit `optical_band` → **NDVI** from labelled RED+NIR
(→ GREEN+NIR) → first explicit labelled band → single band → honest failure.

SAR band precedence: explicit `sar_band` → single band → first labelled band (e.g. VV/VH)
→ honest failure.

### Modality validation

Modality is inferred **only from explicit band metadata** (`detect_modality_from_bands`).
A direct contradiction (e.g. the "optical" file clearly being SAR) fails; an unconfirmed
modality warns but proceeds on the provided label. SAR is **never** assumed merely because
an image is single-band.

### Safe alignment & CRS

- Both images must be **georeferenced** (defined CRS + transform), otherwise it fails
  (cannot align spatially).
- Same CRS + same grid → compared **directly** (`alignment: "direct"`).
- Different CRS or grid → the SAR raster is **deterministically reprojected** onto the
  optical grid with `Resampling.nearest` and `dst_nodata=nan`, so pixels outside the SAR
  footprint are excluded, never fabricated.
- No spatial overlap → structured failure (`status: "failure"`, `confidence: 0.0`).
- Partial overlap → only the overlapping region is analyzed, a warning is added, and
  confidence is reduced to `0.8`.

### Speckle filtering

SAR speckle is reduced with a **deterministic median filter** (default 3×3) implemented
in pure NumPy (`app/preprocessing/speckle_filter.py`) — no scipy / deep-learning
denoiser. Invalid pixels are excluded from the window and remain invalid.

### Nodata / NaN / Inf

Only pixels valid in **both** aligned inputs contribute. Raster nodata, NaN, and Inf are
excluded everywhere; `total_pixels` / `valid_pixels` / `invalid_pixels` are reported.

### Confidence (deterministic)

- `1.0` — direct alignment, full overlap, no warnings.
- `0.8` — reprojection required, partial overlap, or other warnings, but valid pixels exist.
- `0.0` — any validation/alignment failure or no valid overlap.
  Derived from result reliability only — never random.

### Scope boundary

This endpoint returns only **numeric / statistical** evidence. It never outputs semantic
conclusions or a semantic land-cover classification — that is the Agent / VLM / ML layer
(Member 5), which is intentionally left unimplemented here.

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

Install the dev/test dependencies (`pytest` + `httpx`, not required at runtime):

```bash
pip install -r requirements-dev.txt
```

Then:

```bash
python -m pytest -v
```

This runs:

- `test_raster_io.py` — opening rasters, reading metadata, bands, bounds, resolution
- `test_validation.py` — the validation pipeline across valid/corrupt/no-CRS/nodata cases
- `test_band_detection.py` — band identity inference and modality detection
- `test_validate_api.py` — the `/health` and `/validate` HTTP endpoints
- `test_ndvi.py` / `test_ndwi.py` — index computation incl. band detection and honest failure
- `test_area.py` — area math, nodata masking, and geographic-CRS failure
- `test_tools_api.py` — the `/ndvi`, `/ndwi`, and `/area` HTTP endpoints
- `test_change.py` — change math, thresholds, nodata/NaN exclusion, alignment/reprojection, deterministic confidence
- `test_change_api.py` — the `/change` HTTP endpoint (success/failure schema, missing inputs, invalid files)
- `test_fusion.py` — optical+SAR alignment (direct/reprojected), speckle filtering, nodata exclusion, modality warning, deterministic confidence, band override & out-of-range failures
- `test_optical_sar_api.py` — the `/optical-sar` HTTP endpoint (success/failure schema, missing inputs, invalid files/params)

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

## Limitations (Milestone 4)

- Band and modality detection only read **explicit** band metadata/descriptions present
  in the file. They do **not** guess band meaning from band position (e.g. they won't
  assume "band 1 = red") — this is intentional and avoids hardcoding source-specific
  assumptions (Sentinel-2 vs Cartosat-2S vs RISAT slicing).
- Change detection requires a resolvable comparison band. A multi-band pair with no
  explicit band, no common labelled band, and more than one band per image fails
  honestly rather than guessing.
- Change detection needs both images georeferenced **or** both non-georeferenced
  with identical dimensions. A mixed pair (one georeferenced, one not) fails.
- The default `2σ` threshold is a statistical heuristic; it adapts to data scale but
  you should supply an explicit `threshold` when you know the data units.
- Reprojection uses `Resampling.nearest` onto the reference grid and is limited to safe,
  overlapping pairs. Complex multi-sensor registration (feature matching) is not
  attempted — out of scope and would risk invented alignment.
- Optical+SAR fusion requires **both** images georeferenced (for safe spatial alignment);
  non-georeferenced inputs fail honestly.
- SAR values are treated as relative data units. Conversion to physical **dB** backscatter
  is **not** assumed — a documented assumption, since the files carry no radiometric
  metadata. No log(0)/log-of-invalid is ever computed.
- The speckle filter is a simple deterministic median filter (pure NumPy). The vectorized
  sliding-window median is memory-bounded by window size but is a lightweight baseline,
  not an advanced (Lee/refined) speckle filter.
- Optical+SAR fusion is **quantitative only** — it does not classify semantics and it never
  claims an event (flood/deforestation/etc.). Physical SAR units (dB) and radiometric
  calibration are out of scope here.
- `changed_area_km2` / `valid_area_km2` are only reported for a defined, projected
  (non-geographic) CRS; they are `null` otherwise (never `deg × deg`).
- No change mask / fusion GeoTIFF/GeoJSON is emitted yet — the response returns summary
  statistics only (lightweight, no huge pixel arrays).
- No trend / GEE / VQA / training / `/fetch-imagery` for fusion onward; those come in
  later milestones. Semantic interpretation is the Agent / VLM / ML layer (Member 5).
- The endpoints do **not** store the uploaded file permanently; each writes to a
  temp file, computes, then deletes it.

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
