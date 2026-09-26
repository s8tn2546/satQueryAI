# SatQuery AI — System Enhancement Plan & NASA-Grade Roadmap

**Document Status:** Authoritative Master Plan  
**Target Goal:** Transform SatQuery AI into a NASA/Copernicus sponsorship-ready Earth Observation AI platform with live ROI crop execution, rich VLM analysis reporting, multi-spectral STAC integration, and mission-control visual telemetry.

---

## 1. Executive Summary & Core Deficiencies

SatQuery AI currently implements the foundation of a multi-modal satellite query engine (VQA, NDVI, NDWI, Change Detection, Area, Trend). However, to meet NASA Earth Science / startup incubation benchmarks, several critical gaps must be resolved:

1. **Brief / Low-Depth VLM Output**:
   - *Issue*: VQA answers are currently short 1-sentence summaries (~60 tokens).
   - *Cause*: Token cap (`max_new_tokens=60`) in `vlm_loader.py` and lack of structured analytical prompt templates.
   - *Requirement*: Expand generation capacity to 256–512 tokens with multi-paragraph scientific reports, land-cover percentages, confidence factors, and risk metrics.

2. **Broken ROI Dynamic Crop & Analysis Flow**:
   - *Issue*: Selecting an AOI / drawing a region on the globe does not dynamically crop raster pixels from uploaded or catalog scenes to execute region-specific VQA, land cover, or index analysis.
   - *Requirement*: Implement a dynamic spatial raster cropping pipeline (`/tools/roi_crop`) that extracts precise bounding box sub-tensors for VQA, index maps, and area stats.

3. **Georeferencing & Spatial Warning Handling**:
   - *Issue*: `NotGeoreferencedWarning: Dataset has no geotransform` occurs on non-spatial visual TIFFs.
   - *Requirement*: Auto-detect raster type (visual RGBA TIFF vs multispectral GeoTIFF with CRS/transform). Gracefully project and fallback without breaking metadata contracts.

4. **Live NASA Earthdata / Sentinel-2 STAC Ingestion**:
   - *Issue*: Engine relies primarily on static local sample files (`example.tiff`, `sample.tif`).
   - *Requirement*: Integrate Element84 / Microsoft Planetary Computer / NASA Earthdata STAC API querying so users can pick any global ROI and pull real-time Sentinel-2 / Landsat-9 imagery.

5. **Mission-Control Visual Telemetry & UI/UX**:
   - *Issue*: Visual components lack live raster layer switching (RGB vs NDVI vs Water Mask over ROI), dual-pane comparison, and telemetry indicators.
   - *Requirement*: Implement layer opacity controls, live ROI spatial bounding box badges, band histograms, and split-screen temporal comparison.

---

## 2. Master Enhancement Checklist

### Phase 1: High-Priority Core Fixes (ROI & VLM Depth)
- [ ] **[ML Service]** Increase `max_new_tokens` from 60 to 256/512 in `ml-service/app/models/vlm_loader.py` for rich analytical descriptions.
- [ ] **[ML Service]** Add structured VQA prompt engineering for NASA-grade report generation (Land Cover %, Hydrological Status, Urban Density, Vegetation Health).
- [ ] **[ML Service]** Create `/api/roi/crop` tool in `ml-service/app/tools/roi_crop.py` using `rasterio.mask.mask` to crop exact ROI bounds from GeoTIFF files.
- [ ] **[Backend]** Wire backend agent planner (`backend/src/agents/planner.js`) to route ROI bounding-box queries through the spatial crop pipeline.
- [ ] **[Frontend]** Ensure `GlobeView.jsx` ROI drawing triggers explicit `/api/query` with `roiAttachment` bounds + selected raster reference.

### Phase 2: Live STAC & Multi-Spectral Data Pipeline
- [ ] **[ML Service]** Add STAC catalog search tool (`ml-service/app/tools/stac.py`) querying Sentinel-2 / Landsat-9 for any user-drawn ROI.
- [ ] **[Backend]** Implement STAC search route (`POST /api/stac/search`) and metadata persistence in MongoDB `Tile` collection.
- [ ] **[Frontend]** Add STAC Scene Picker component on the 3D globe to preview and select live satellite passes over the drawn AOI.

### Phase 3: Spatial Visualization & Globe Layer Controls
- [ ] **[Frontend]** Implement interactive Layer Switcher overlay on `GlobeView.jsx` (RGB visual, NDVI heatmap, NDWI water mask, Change mask).
- [ ] **[Frontend]** Add live spatial telemetry overlay: coordinate readouts (LAT/LON), pixel area ($km^2$), resolution indicator ($10m$).
- [ ] **[Frontend]** Implement Dual-Pane Split-Screen comparison mode for change detection (Before vs After rasters).

### Phase 4: Production Hardening & Async Job Queue
- [ ] **[ML Service]** Implement background thread pool / Redis queue for heavy VLM CPU/GPU inference tasks to prevent HTTP connection timeouts.
- [ ] **[Backend]** Add async job status polling (`GET /api/query/status/:jobId`) for long-running VLM queries.

---

## 3. Sub-Component Markdown Reference

Specific required changes have been documented in each module's respective markdown specification:
- **Frontend Enhancements**: `frontend/FRONTEND.md` (Section 10)
- **Backend Orchestrator Enhancements**: `backend/BACKEND.md` (Section 10)
- **ML & Geospatial Service Enhancements**: `ml-service/ML_SERVICE.md` (Section 10)
