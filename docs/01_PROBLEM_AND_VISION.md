# SatQuery AI — Problem Statement & Vision Guide

## 1. Problem Statement & Background

Remote Sensing (RS) and Earth Observation (EO) data from satellites like **Sentinel-2**, **Landsat-9**, and **Sentinel-1 (SAR)** provide critical planet-scale insights for agriculture, urban planning, disaster response, and climate monitoring.

However, extracting actionable insights from raw satellite rasters currently requires:
- Deep domain expertise in GIS tools (QGIS, ArcGIS, ENVI).
- Manual raster band mathematics (e.g., calculating NDVI $(NIR - Red) / (NIR + Red)$ or NDWI $(Green - NIR) / (Green + NIR)$).
- Complex programming using GDAL, Rasterio, or Google Earth Engine.
- Heavy manual labor to interpret land cover changes and visually ground features.

### The Core Challenge
Non-expert decision makers (disaster responders, urban planners, environmental policy analysts) need a **natural-language query system** where they can simply ask:
> *"What is the vegetation condition in this region over the past 6 months?"*  
> *"Is there flood water encroaching near the urban zone in this satellite scene?"*  
> *"What is the total surface area of water in this GeoTIFF?"*

---

## 2. SatQuery AI Vision

SatQuery AI is an **Agentic Multimodal Remote-Sensing Intelligence Platform** that bridges the gap between raw raster pixels and natural-language natural intelligence.

### Key Pillars
1. **Natural-Language Understanding**: Intercepts complex queries, classifies intent, and decomposes them into executable tool chains.
2. **Local Vision-Language Processing**: Leverages fine-tuned **Qwen2-VL-2B-Instruct** for local, offline VQA (Visual Question Answering) and remote-sensing scene captioning without sending raw imagery to cloud LLMs.
3. **Rigorous Geospatial Computation**: Executes exact raster math (`rasterio`, `numpy`, `shapely`) for NDVI, NDWI, surface area calculations, and change detection.
4. **Transparent Trust Layer**: Returns complete observable evidence—confidence metrics, model metadata, execution step traces, and interactive map layers—so users can verify AI claims against ground truth.
5. **Interactive 3D Globe Experience**: Uses **CesiumJS** to render 3D Earth terrain, satellite imagery basemaps, custom AOI bounds, and analytical overlays.

---

## 3. NASA / Copernicus Enterprise Vision

To qualify for NASA Earth Science incubation / enterprise sponsorship, SatQuery AI is engineered to meet 4 critical standards:

1. **Multi-Spectral Awareness**: Capability to process 12-band Sentinel-2 imagery, non-georeferenced optical rasters, and synthetic aperture radar (SAR) pairs.
2. **Open STAC Standard Support**: Querying global STAC (SpatioTemporal Asset Catalog) endpoints for dynamic scene acquisition over any user-drawn AOI.
3. **Reproducible GEOINT Reports**: Exporting complete geospatial intelligence summaries containing coordinate bounding boxes, band math statistics, visual overlays, and step-by-step audit traces.
4. **Privacy & Offline Operations**: Local VLM inference capability ensuring sensitive geospatial intelligence data never leaves local infrastructure.
