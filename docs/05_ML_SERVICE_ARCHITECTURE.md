# SatQuery AI — ML & Geospatial Service Architecture

## 1. Overview & Tech Stack

The ML service is a Python microservice built with **FastAPI** that owns all model inference, raster I/O, band mathematics, and remote-sensing computation.

- **Framework**: FastAPI + Uvicorn
- **Vision-Language Model**: `Qwen/Qwen2-VL-2B-Instruct` (loaded locally via PyTorch)
- **Adaptation Framework**: Hugging Face `peft` (LoRA adapter support)
- **Raster Processing**: `rasterio`, `numpy`, `PIL`
- **Geospatial & Geometry**: `shapely`, `pyproj`
- **Port**: `8080` (or configured via environment)

---

## 2. Directory Structure

```
ml-service/app/
├── main.py                     # FastAPI app entry point & router registration
├── api/                        # Endpoint route definitions
│   ├── validate.py             # POST /validate endpoint
│   ├── vqa.py                  # POST /vqa endpoint
│   ├── caption.py              # POST /caption endpoint
│   ├── ndvi.py                 # POST /ndvi endpoint
│   ├── ndwi.py                 # POST /ndwi endpoint
│   ├── area.py                 # POST /area endpoint
│   ├── change.py               # POST /change endpoint
│   ├── optical_sar.py          # POST /optical-sar endpoint
│   ├── trend.py                # POST /trend endpoint
│   └── fetch_imagery.py        # POST /fetch-imagery endpoint
├── models/
│   └── vlm_loader.py           # PyTorch Qwen2-VL model loader & generation engine
├── tools/                      # Pure Python numerical & geospatial tools
│   ├── vqa.py
│   ├── caption.py
│   ├── ndvi.py
│   ├── ndwi.py
│   ├── area.py
│   ├── change.py
│   ├── fusion.py
│   ├── trend.py
│   ├── fetch_imagery.py
│   ├── band_utils.py
│   └── index_utils.py
├── geospatial/                 # Spatial I/O, CRS handling & validation
│   ├── raster_io.py            # Rasterio multi-band loading & normalization
│   ├── crs.py                  # Pyproj coordinate reprojector
│   └── validation.py           # GeoTIFF metadata validator & checker
├── preprocessing/              # Image normalization & filtering
│   ├── loader.py
│   ├── normalize.py
│   ├── band_detection.py
│   └── speckle_filter.py      # Lee speckle filter for SAR rasters
├── schemas/                    # Pydantic request/response schemas
│   ├── common.py
│   └── requests.py
└── services/
    └── gee_client.py           # Google Earth Engine API integration
```

---

## 3. File-by-File Breakdown

### Core Entry & Model Loader (`app/main.py` & `app/models/`)

- **`app/main.py`**: FastAPI application setup. Registers CORS middleware, health check endpoints (`/health`), model warmup route (`POST /vlm/warmup`), and includes API routers from `app/api/`.
- **`app/models/vlm_loader.py`**: Singleton class managing **Qwen2-VL-2B-Instruct**:
  - Lazily loads model weights on first inference request to save CPU memory.
  - Automatically targets available hardware (`cuda` if GPU present, `cpu` with `torch.float32` fallback).
  - Integrates optional LoRA adapters via `peft.PeftModel.from_pretrained()`.
  - Executes autoregressive text generation given input images and prompt strings.

### Geospatial Core & I/O (`app/geospatial/` & `app/preprocessing/`)

- **`app/geospatial/raster_io.py`**:
  - Reads raw 8-bit, 16-bit, and float GeoTIFF files using `rasterio`.
  - Normalizes 16-bit surface reflectance values using 2%–98% percentile cumulative stretching.
  - Converts multi-band rasters to 3-channel RGB PIL Images for VLM ingestion.
  - Handles `NotGeoreferencedWarning` gracefully for non-spatial images.

- **`app/geospatial/validation.py`**:
  - Inspects upload raster files and checks: width/height, band counts, data types, CRS, spatial bounds, and resolution.
  - Assigns tile modality (`optical` vs `sar`).

- **`app/preprocessing/speckle_filter.py`**:
  - Implements **Lee Speckle Filter** algorithm using 7x7 spatial moving windows on SAR intensity bands to reduce granular radar noise before analysis.

- **`app/preprocessing/band_detection.py`**:
  - Scans GeoTIFF metadata and wavelength tags to automatically identify Red, Green, Blue, and Near-Infrared (NIR) band indices.

### Geospatial & ML Tool Executors (`app/tools/`)

- **`app/tools/ndvi.py`**: Calculates Normalized Difference Vegetation Index:
  $$\text{NDVI} = \frac{\text{NIR} - \text{Red}}{\text{NIR} + \text{Red}}$$
  Generates continuous floating-point index array, mean vegetation score, and visual colorized heatmap PNG.

- **`app/tools/ndwi.py`**: Calculates Normalized Difference Water Index:
  $$\text{NDWI} = \frac{\text{Green} - \text{NIR}}{\text{Green} + \text{NIR}}$$
  Identifies open surface water bodies and extracts water mask boundaries.

- **`app/tools/area.py`**: Computes spatial polygon geometry area in $km^2$ using `shapely` and `pyproj` geodetic transformations.

- **`app/tools/change.py`**: Takes two co-registered optical scenes (Before vs After), computes pixel difference magnitude array, applies thresholding, and returns percentage land cover change.

- **`app/tools/fusion.py`**: Combines optical RGB imagery with Sentinel-1 SAR intensity channels for optical+SAR joint classification.

- **`app/tools/vqa.py`**: Wraps `vlm_loader.py` to execute visual question answering on satellite scene rasters.

- **`app/tools/caption.py`**: Wraps `vlm_loader.py` to produce VRSBench-style descriptive captions for satellite scenes.

### API Endpoint Routes (`app/api/`)

- **`app/api/validate.py`**: Endpoint `POST /validate` returning raster file properties and suitability score.
- **`app/api/vqa.py`**: Endpoint `POST /vqa` accepting image file and prompt question, returning Section 8 standard tool output JSON schema.
- **`app/api/ndvi.py`**: Endpoint `POST /ndvi` executing vegetation math.
- **`app/api/ndwi.py`**: Endpoint `POST /ndwi` executing water math.
- **`app/api/change.py`**: Endpoint `POST /change` executing temporal difference math.
- **`app/api/area.py`**: Endpoint `POST /area` executing surface area math.
