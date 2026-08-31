# SatQuery AI — ML / Geospatial Service

The **ML and Geospatial service** for the SatQuery AI project. This FastAPI-based
Python service is where all pixel-level work happens: reading rasters, validating
images, computing NDVI/NDWI/area, change/fusion, historical trend analysis, and
region-based imagery acquisition (via Google Earth Engine).

**Important architectural rule:** this service never talks to the frontend directly
and never decides which tool to call — that is the Node.js backend's job (see
`backend/BACKEND.md`). This service exposes narrow, well-defined HTTP endpoints and
does the actual work when the backend calls them.

---

## Milestone 1 + 2 + 3 + 4 + 5 + 6 scope — what this currently does

This implements **Milestone 1 (foundation)**, **Milestone 2 (geospatial tools)**,
**Milestone 3 (bi-temporal change detection)**, **Milestone 4 (optical+SAR
fusion / cross-modal analysis)**, **Milestone 5 (historical trend analysis via
Google Earth Engine)**, and **Milestone 6 (region-based imagery acquisition
via Google Earth Engine)**:

| Capability | Status |
|---|---|
| FastAPI application + `/health` | ✅ Done |
| `/validate` endpoint | ✅ Done |
| `/ndvi` endpoint (Normalized Difference Vegetation Index) | ✅ Done |
| `/ndwi` endpoint (Normalized Difference Water Index) | ✅ Done |
| `/area` endpoint (surface area from valid pixels) | ✅ Done |
| `/change` endpoint (bi-temporal change detection) | ✅ Done |
| `/optical-sar` endpoint (optical + SAR cross-modal analysis) | ✅ Done |
| `/trend` endpoint (historical trend analysis via GEE) | ✅ Done |
| `/fetch-imagery` endpoint (region-based optical + SAR acquisition via GEE) | ✅ Done |
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
| Trend region/date/metric validation + deterministic trend stats | ✅ Done |
| Fetch bbox/date validation + least-cloudy S2 + nearest-date S1 acquisition | ✅ Done |
| Fetched-raster validation-pipeline integration + acquisition metadata | ✅ Done |
| GEE provider abstraction (real + explicit mock, clean failures) | ✅ Done |
| Unit tests using synthetic rasters (no live GEE required) | ✅ Done |
| Dockerfile | ✅ (not built in this environment) |

**Not yet implemented** (later milestones / other members): VQA, captioning,
grounding, model training, LoRA adaptation, `/fetch`, and any semantic
interpretation of the imagery/trend evidence. Semantic interpretation is the
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

POST /trend ──▶ app/api/trend.py ──▶ app/tools/trend.py ──▶ app/services/gee_client.py
                    └── region/date/metric validation + statistics (pure)
                        └── GeeProvider abstraction
                            ├── RealGeeProvider (ee, credentials from env)
                            └── MockGeeProvider (deterministic fixture, tagged "mock")

POST /fetch-imagery ──▶ app/api/fetch_imagery.py ──▶ app/tools/fetch_imagery.py
                    └── bbox/date validation + download/validation-orchestration (pure)
                        └── GeeProvider.fetch_pair (reuses the same provider)
                            ├── Real: least-cloudy S2 + nearest-date S1 + GeoTIFF download
                            └── Mock: deterministic metadata only (no files, tagged "mock")
                                └── downloaded rasters ──▶ app/geospatial/validation.py
```

- **`app/geospatial/`** — raster I/O, CRS handling, and the validation pipeline.
- **`app/preprocessing/`** — image loading, band detection, normalization, speckle filtering.
- **`app/tools/`** — the actual computation (NDVI, NDWI, area, change, fusion, trend, imagery acquisition) plus
  shared band-resolution, index, and alignment utilities.
- **`app/services/`** — external data-provider abstractions (Google Earth Engine client).
- **`app/api/`** — FastAPI route definitions.
- **`app/schemas/`** — Pydantic request/response models.

The module responsibilities are kept small and focused.

---

## Prerequisites

- **Python 3.11+** (this was developed and tested on 3.14)
- `git`

The heavy ML libraries (PyTorch, Transformers) are **not** needed for Milestones 1–5.
The Google Earth Engine Python API (`earthengine-api`) is included in
`requirements.txt` but is imported lazily — the rest of the service runs without it,
and `/trend` fails clearly (rather than fabricating data) when GEE is unavailable.

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

## Historical Trend endpoint

```
POST /trend
```

**Historical trend analysis** retrieves a remote-sensing metric over a region and a
date range and returns a **quantitative time series + trend summary** (e.g. "NDVI
decreased over the requested period"). Answers queries like *"How has vegetation
changed over the last 5 years?"*, *"Has water coverage increased or decreased?"*.

This endpoint produces **quantitative temporal evidence only** — it never concludes
"deforestation happened" / "flooding occurred". Semantic interpretation is the
Agent / ML / VLM layer's job (Member 5).

Unlike the file-upload endpoints, `/trend` takes a **JSON body**:

```json
{
  "region": {
    "type": "Polygon",
    "coordinates": [[[78.0, 28.0], [78.5, 28.0], [78.5, 28.5], [78.0, 28.5], [78.0, 28.0]]]
  },
  "start_date": "2021-01-01",
  "end_date": "2023-12-01",
  "metric": "ndvi",
  "interval": "monthly"
}
```

Request fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `region` | GeoJSON | yes | `Polygon` or `MultiPolygon` geometry. |
| `start_date` | string | yes | ISO `YYYY-MM-DD`, inclusive. |
| `end_date` | string | yes | ISO `YYYY-MM-DD`, must be after `start_date` and not in the future. |
| `metric` | string | no | `ndvi` (vegetation) or `ndwi` (water). Default `ndvi`. |
| `interval` | string | no | `monthly` or `yearly`. Default `monthly`. |

### What the pipeline does

Validate region → validate dates → validate metric → query GEE provider → spatial +
temporal filtering → cloud/quality masking → metric calculation (NDVI/NDWI) →
regional reduction (`reduceRegion` mean) per time bucket → chronological time series →
deterministic trend statistics → evidence → confidence → `ToolOutput`.

### Supported metrics (no silent substitution)

- **`ndvi`** = `(NIR - RED) / (NIR + RED)` — vegetation.
- **`ndwi`** = `(GREEN - NIR) / (GREEN + NIR)` — open water (McFeeters).

Unsupported metrics return a structured `failed` result — the service never silently
substitutes one metric for another.

### Dataset / collection

Sentinel-2 Surface Reflectance (`COPERNICUS/S2_SR_HARMONIZED`) is used for both optical
trend metrics — the archive named in `ML_SERVICE.md` as the practical optical dataset
for on-demand analysis (ISRO's own imagery cannot be pulled on-demand for an arbitrary
coordinate).

Band mapping (documented, not position-guessed):

| Metric | Bands |
|---|---|
| NDVI | `B8` (NIR), `B4` (RED) |
| NDWI | `B3` (GREEN), `B8` (NIR) |

### Cloud / quality masking

Sentinel-2 `QA60` bitmask (bits 10 = opaque cloud, 11 = cirrus) is masked, and scenes
with `CLOUDY_PIXEL_PERCENTAGE >= 20` are filtered out. If reliable masking cannot be
performed, that limitation is reported rather than fabricating clean-looking data.

### Temporal aggregation / missing observations

A monthly (default) or yearly regional median composite is produced and reduced over
the region, giving one value per bucket. Periods with no valid imagery (clouds, no
scenes, insufficient pixels) are represented **honestly** as
`{"value": null, "status": "missing"}` — never fabricated or interpolated. Duplicate
timestamps keep the last value (documented, with a warning).

### Trend statistics (deterministic)

- `first_value`, `last_value`, `min`, `max`, `mean`
- `slope` — simple linear regression `value = slope * day_index + intercept`, where
  `day_index` = days since the first observation (unit: **per day**).
- `percentage_change` = `((last - first) / abs(first)) * 100`; returns `null` (with a
  note) when `first_value == 0` — never `inf`/`NaN`.
- `direction` — `increasing` / `decreasing` / `stable` from the total index change,
  with a documented tolerance (`0.02` on the `-1..+1` index scale).
- `observation_count`, `missing_count`.

Confidence is **reliability of the result**, never statistical significance. No
significance test is claimed.

### GEE authentication

Credentials come **only** from the environment (never hard-coded): `GEE_PROJECT_ID`,
`GEE_SERVICE_ACCOUNT`, `GEE_SERVICE_ACCOUNT_KEY_PATH` (see `.env.example`). Real GEE
data is used only when these are configured. Otherwise `/trend` returns a clear
structured `failed` result (confidence 0.0) — it does **not** fabricate observations.

### Real GEE data vs. Mock/test data

The provider is selected by `GEE_MODE`:
- unset / `real` → `RealGeeProvider` (live GEE; fails clearly without credentials).
- `mock` / `dev` → `MockGeeProvider` (deterministic synthetic fixture, **not** real
  data).

Every response is explicitly labelled via `metadata.data_source` (`gee` or `mock`),
and mock/fixture responses carry a `source_warning` so real and test data can never be
confused. Mock data yields confidence `0.8`; clean real data yields `1.0`.

### Caching

Caching of trend results is **owned by the Node backend** (`backend/src/models/ResultsCache.js`,
`BACKEND.md` §10): the backend calls `/trend`, then writes the returned series into
`results_cache` keyed by `{ region, metric, dateRange, interval }`. The ML service does
not own or write to the cache.

---

## Imagery Acquisition endpoint (`/fetch-imagery`)

```
POST /fetch-imagery
```

**Region-based imagery acquisition** (ML_SERVICE.md §10.8 stretch; supports
BACKEND.md §6.1a and the frontend region picker). Given a geographic bounding box,
it finds and returns a co-registered **optical (Sentinel-2) + SAR (Sentinel-1) pair**
covering that region via Google Earth Engine, and runs any downloaded rasters through
the existing validation pipeline.

This is an **acquisition** step, not an agent tool. It produces the same per-image
metadata (file path, modality, source, capture date, bbox, CRS, resolution, bands)
that a direct upload produces, so the backend can store each returned image as a
`tiles` document with `source: "gee-fetch"` and `validated` set from the ML service's
validation.

Request body (JSON):

```json
{
  "bounding_box": {
    "type": "Polygon",
    "coordinates": [[[78.0, 28.0], [78.5, 28.0], [78.5, 28.5], [78.0, 28.5], [78.0, 28.0]]]
  },
  "start_date": "2021-01-01",
  "end_date": "2021-06-01",
  "preferred_date": "2021-03-15"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `bounding_box` | GeoJSON | yes | `Polygon` or `MultiPolygon` geometry in lon/lat. |
| `start_date` | string | no | ISO `YYYY-MM-DD`, inclusive search-window start. |
| `end_date` | string | no | ISO `YYYY-MM-DD`, inclusive search-window end. |
| `preferred_date` | string | no | ISO `YYYY-MM-DD`; anchors the SAR nearest-date search. |

If neither `start_date` nor `end_date` is given, the search window defaults to the
documented "reasonable recent" range of `DEFAULT_FETCH_DAYS` (90 days) ending today.

### What the pipeline does

Validate bounding box → validate/normalise the date window → query the GEE provider
for a pair → (real) download both scenes as local GeoTIFFs → run each downloaded
raster through `app/geospatial/validation.py` → attach acquisition + validation
metadata → deterministic confidence → `ToolOutput`.

### Sentinel-2 (optical)

- Collection `COPERNICUS/S2_SR_HARMONIZED` (the archive already used by `/trend`).
- Selects the **least-cloudy** suitable scene (`CLOUDY_PIXEL_PERCENTAGE < 20`,
  sorted ascending) over the region and window — never a random scene.
- Applies a documented cloud/quality mask (`QA60` bits 10/11 + cloud filter) and
  exports `B2/B3/B4/B8` at 10 m resolution.
- Returns `cloudCover`, `quality_mask`, `captureDate`, `product_id`, etc.

### Sentinel-1 (SAR)

- Collection `COPERNICUS/S1_GRD` (Ground Range Detected).
- Selects the **nearest acquisition date** to the chosen optical scene within a
  documented tolerance (`SAR_TOLERANCE_DAYS = 7`). Exact same-day matches are
  unlikely, so a small window is accepted (documented, as §10.8 requires).
- **SAR is never treated as optical.** `modality: "sar"` with SAR-specific metadata
  preserved: `polarization` (`VV`/`VH`), `orbit`, `sar_processing`, `product_id`.

### Bounding box

Accept a GeoJSON `Polygon`/`MultiPolygon` in lon/lat. Validates longitude `[-180,180]`,
latitude `[-90,90]`, non-empty, valid (shapely), and **non-zero area**. Rejects
malformed/empty/invalid/zero-area/Point inputs — never silently repairs them.

### Dates

ISO `YYYY-MM-DD`; `start < end`; **future dates rejected**; window bounded to the
project's documented span cap (30 years). No dates are invented.

### Download / export

Real mode exports both scenes as **local GeoTIFFs** to a temporary directory (no
cloud storage) and returns their `filePath`. Non-georeferenced or empty outputs fail
the validation pipeline honestly. The files are kept for the request so the backend
can reference `filePath` when storing the tile documents (the backend/temp layer owns
their lifecycle). Mock mode produces **no files** (see below).

### Validation-pipeline integration

Every raster that is actually downloaded (real mode) is passed through
`run_validation()` (geospatial + raster + band + data-quality checks). Each image's
`validated` flag, `validation_status`, and any `validation_warnings`/`validation_errors`
are attached. Pair-level co-registration is handled downstream by the existing
`/change` / `/optical-sar` tools when the pair is consumed.

### GEE authentication

Credentials come **only** from the environment (`GEE_PROJECT_ID`,
`GEE_SERVICE_ACCOUNT`, `GEE_SERVICE_ACCOUNT_KEY_PATH` — see `.env.example`), never
hard-coded. Real GEE data is used only when these are configured; otherwise
`/fetch-imagery` returns a clear, structured `failed` result (confidence 0.0) — it
does **not** fabricate imagery.

### Real GEE data vs. Mock/test data

The provider is selected by `GEE_MODE` (same mechanism and `GeeProvider` as `/trend`):

- unset / `real` → `RealGeeProvider` — live GEE, downloads real GeoTIFFs, fails
  clearly without credentials.
- `mock` / `dev` → `MockGeeProvider` — deterministic acquisition **metadata only**
  (no files), explicitly labelled `source: "mock"`, `downloaded: false`,
  `filePath: null`, plus a `source_warning`.

Every response carries `metadata.data_source` (`gee` or `mock`) so real and test data
can never be confused. Mock → confidence `0.7`; clean real pair → `1.0`.

### Confidence (deterministic)

Reliability-based, never random, never statistical significance:

- `0.7` — explicit mock/fixture acquisition.
- `1.0` — real, complete optical+SAR pair, both downloaded and validated, no warnings.
- `0.8` — real pair with warnings (e.g. large `date_gap_days`, validation warnings).
- `0.5` — only one of the pair acquired (partial).
- `0.0` — failure / no usable imagery.

### Caching

Like `/trend`, persistence of fetched tiles is **owned by the Node backend**: it
stores each returned image as a `tiles` document (source `"gee-fetch"`, `filePath`
pointing at the returned raster, `validated` taken from the ML response). The ML
service does not write to the backend database.

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
- `test_trend.py` — region/date/metric validation, chronological + missing/duplicate handling, deterministic trend stats (increase/decrease/stable, slope, percentage change, no NaN/Inf), provider selection, GEE-auth & query-failure behavior
- `test_trend_api.py` — the `/trend` HTTP endpoint (success schema, data_source labelling, missing fields → 422, validation failure, GEE-unavailable structured failure, deterministic confidence)
- `test_fetch_imagery.py` — bbox validation (valid/invalid/zero-area/bad lon/bad lat), date-window validation (defaults/order/future/preferred hint), deterministic mock provider (explicitly labelled, no files), real provider fails clearly without creds, orchestrator (mock, fake-real download+validate, partial, no-image, unsupported modality), SAR identity preserved, no NaN/Infinity JSON
- `test_fetch_imagery_api.py` — the `/fetch-imagery` HTTP endpoint (success schema, data_source labelling, Sentinel-2 + Sentinel-1 metadata, missing fields → 422, invalid bbox, invalid/future dates, GEE-auth and GEE-query structured failures, real validated pair → confidence 1.0, partial → 0.5, deterministic confidence, no NaN/Infinity)

Trend and fetch tests require **no live GEE**: they use deterministic mock/fake
providers (and override the FastAPI dependency) so they run offline and stay
deterministic.

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

## Limitations (Milestones 4–6)

- Imagery acquisition is **quantitative acquisition only** — it never interprets the
  fetched scene (flood/deforestation/land cover). Semantic interpretation is Member 5's.
- Live GEE fetch could **not** be verified in this environment (no `GEE_*` credentials/
  project). `RealGeeProvider.fetch_pair` (least-cloudy S2 + nearest-date S1 + GeoTIFF
  download) is implemented but only runs with credentials; without them, `/fetch-imagery`
  returns a clear failure — verified by tests and boot checks. The `earthengine-api`
  dependency is installed but never imports on a normal code path (lazy).
- Sentinel-1 (SAR) is restricted to the GRD archive and a documented nearest-date
  tolerance (`SAR_TOLERANCE_DAYS = 7`); a scene outside that window is reported as
  "no sufficiently close SAR pass" rather than forcing a pair.
- Mock mode returns acquisition **metadata only** — it does not (and must not) produce
  files that could be mistaken for real imagery. `filePath` is `null` and `downloaded`
  is `false` for mock output.
- Downloaded rasters are exported at a fixed 10 m scale over the requested bbox; very
  large regions produce large files and cost more GEE compute. No arbitrary bbox-size
  cap is enforced (the spec does not require one).
- `preferred_date` is a hint anchored for the SAR search; if it falls outside the
  window it is logged as a warning, not an error. No dates are invented.
- Trend analysis is **quantitative only** — it never concludes a semantic event
  (deforestation/flood/urbanization) from a slope; interpretation is Member 5's job.
- Live GEE data could **not** be verified in this environment (no `GEE_*` credentials/
  project were available). `/trend` uses `RealGeeProvider` only when credentials are
  configured, and otherwise returns a clear failure — verified by tests and boot checks.
  The `earthengine-api` dependency is installed but never imports on a normal code path
  (lazy).
- Trend supports `ndvi` and `ndwi` only (optical Sentinel-2). Unsupported metrics fail
  rather than being silently substituted.
- Region must be a GeoJSON `Polygon`/`MultiPolygon` in geographic (lon/lat) coordinates.
  Point/LineString/bbox-only inputs are not accepted; the backend sends a polygon region.
- Dates must be in the past and within a documented max span (30 years); future dates are
  rejected.
- Missing observation periods are represented as `value: null` + `status: "missing"` —
  they are never interpolated. If a finer fill is later wanted, it must be added
  explicitly (out of scope now).
- Trend confidence is reliability-based (mock → 0.8, clean real data → 1.0). It is
  **not** a statistical-significance measure; no significance test is implemented or
  claimed.
- The GEE query uses monthly/yearly median composites with `reduceRegion(mean)` —
  a documented, efficient server-side reduction that avoids downloading full rasters.
  Large regions / long ranges increase cloud-side cost and are bounded by the span cap.
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
- No VQA / training / `/fetch-imagery` yet; those come in later milestones.
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
