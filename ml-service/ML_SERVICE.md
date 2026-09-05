# SatQuery AI — ML / Geospatial Service Implementation Guide

**This is the authoritative ML-service reference for this repo. Refer to this document before implementing any model, tool, or geospatial function. If anything here conflicts with the SIH Problem Statement (SIH26167), the Problem Statement wins.**

---

## 1. Role and Scope

The ML service (Python + FastAPI) is where **every pixel gets touched**. It owns:

1. Reading and validating raw raster files (GeoTIFF/TIFF, and PNG/JPEG for benchmark inputs)
2. All model inference: VQA, captioning/grounding, change analysis, optical+SAR fusion
3. All geospatial computation: NDVI, NDWI, area, historical trend (GEE)
4. The **remote-sensing adaptation** deliverable — at least one visual/VLM component genuinely fine-tuned on remote-sensing data
5. Returning results in the **standard tool output schema** (Section 8) so the backend can assemble evidence/confidence/trace without re-deriving anything

**This service never talks to the frontend directly and never makes product decisions about which tool to call** — that's the backend agent's job (see `BACKEND.md`). This service just exposes narrow, well-defined endpoints and does the actual work when called.

---

## 2. Tech Stack

| Component | Choice |
|---|---|
| Framework | FastAPI |
| Raster I/O | `rasterio` |
| Numerical computation | `numpy` |
| Geometry | `shapely` |
| CRS handling | `pyproj` |
| ML framework | PyTorch + Hugging Face `transformers` |
| Adaptation technique | LoRA (via Hugging Face `peft`) |
| Historical archive | Google Earth Engine Python API (`ee`) |
| Containerization | Docker (own Dockerfile, orchestrated via root `docker-compose.yml`) |

---

## 3. Folder Structure

```
ml-service/
  app/
    api/              # FastAPI route definitions, one file per tool where practical
    models/           # model loading/wrapping code (VQA, captioning, grounding, change, fusion)
    tools/            # ndvi.py, ndwi.py, area.py, trend.py — pure geospatial computation
    geospatial/        # shared raster I/O, CRS handling, co-registration checks
    preprocessing/     # image loading, band extraction, speckle filtering (SAR), normalization
    schemas/           # Pydantic request/response models matching Section 8
  adaptation/          # fine-tuning scripts, config, and adaptation documentation (Section 7)
  tests/
  requirements.txt
  Dockerfile
  .env.example
```

---

## 4. Environment Variables

```
PORT=
GEE_SERVICE_ACCOUNT_KEY_PATH=
MODEL_CHECKPOINT_DIR=
DEVICE=            # cpu or cuda
```

---

## 5. Endpoints (called only by the Node backend, never directly by the frontend)

| Method | Path | Purpose | PS capability |
|---|---|---|---|
| POST | `/vqa` | Answer a question about one image | Single-image VQA (mandatory) |
| POST | `/caption` | Generate a scene description | Single-image extra task, option A |
| POST | `/ground` | Return a bounding box/mask for a referenced object/region | Single-image extra task, option B |
| POST | `/change` | Describe or answer a question about change between two dates | Bi-temporal change (mandatory) |
| POST | `/optical-sar` | Extract complementary information from a co-registered optical+SAR pair | Cross-modal analysis (mandatory) |
| POST | `/ndvi` | Compute vegetation index | Supporting tool |
| POST | `/ndwi` | Compute water index | Supporting tool |
| POST | `/area` | Convert a mask/pixel count to real-world area | Supporting tool |
| POST | `/trend` | Compute a historical time series via GEE | Supporting tool, MEDIUM priority |
| POST | `/validate` | Run the full input/pair validation pipeline (Section 6) — can be called standalone by the agent before committing to a tool | Cross-cutting |
| POST | `/fetch-imagery` | STRETCH — given a bounding box, find and return a co-registered optical + SAR pair for that region (Section 10.8) | Supports the frontend region picker, not a PS-mandatory endpoint |

Every endpoint accepts a `tileId`/file reference (not raw bytes over the wire where avoidable) plus task-specific parameters, and returns the standard output schema from Section 8.

---

## 6. Input and Pair Validation — the real, raster-level checks

This is where the checks that `BACKEND.md` intentionally left as "structural only" actually get done. Implement as a shared module in `app/geospatial/validation.py`, used by every tool endpoint before it runs.

### 6.1 Single image

- File opens successfully with `rasterio` (or PIL for PNG/JPEG benchmark inputs)
- Band count matches what's expected for the modality (optical needs at minimum Red + NIR for any index-based tool; SAR is typically single or dual-polarization)
- Modality identification: infer optical vs. SAR from metadata/band structure if not explicitly tagged
- If GeoTIFF: extract CRS, bounding box, resolution, acquisition date from metadata
- If PNG/JPEG (benchmark case): skip geospatial metadata checks, proceed with a lighter validation path — **do not assume every image has a CRS**

### 6.2 Cross-modal pair (optical + SAR)

- Both images present, one identified as optical, one as SAR
- Bounding boxes overlap (same geographic area) — compare using `shapely`
- CRS compatible — reproject with `pyproj` if needed before comparison
- **Co-registration check**: verify the two images align to the same pixel grid for their overlapping extent (check pixel dimensions against known resolution and bounding box math; flag if misaligned beyond a reasonable tolerance)
- If co-registration cannot be verified, return a validation failure with a specific reason — **do not let a tool proceed to "joint analysis" on an unverified pair**

### 6.3 Bi-temporal pair

- Both images present, same modality expected (or explicitly note if comparing across modalities, which is a different, harder case — scope to same-modality bi-temporal for this sprint unless time allows more)
- Bounding boxes overlap (same geographic area)
- Acquisition dates differ and are both extractable
- CRS compatible

### 6.4 SAR-specific preprocessing note

SAR images carry inherent speckle noise. Before running any model or computation on a SAR image, apply a basic speckle filter (e.g. a Lee filter or simple median filter) in `app/preprocessing/`. Skipping this will visibly degrade both fusion and change-analysis quality on SAR inputs.

### 6.5 Working generically across Sentinel-2, Bhuvan, Cartosat-2S, and RISAT

**Do not hardcode band indices or resolution assumptions tied to Sentinel-2** (e.g. "band 8 is always NIR"). The final evaluation set uses Cartosat-2S/RISAT pairs, which will have different band layouts and metadata conventions. Read band semantics from file metadata where possible, and keep any per-source band mapping in a small, explicit config table rather than inline magic numbers — so adding a new source later is a config change, not a code change.

---

## 7. Remote-Sensing Adaptation (Mandatory Deliverable)

### 7.1 What "done" looks like

At least one visual/VLM component must be genuinely fine-tuned or adapted using **BigEarthNet.txt or any open-source remote-sensing training data** — not merely prompted. This must be documented, not just claimed.

### 7.2 Recommended approach: LoRA fine-tuning

1. Choose a base pretrained open-source VLM (something with existing image+text capability, small enough to fine-tune quickly)
2. Apply LoRA via Hugging Face `peft` — freeze the base model, train only small adapter layers
3. Train on a focused subset of one dataset, mapped to one capability:
   - **RSVQA** → adapt the VQA tool directly (cleanest match to the mandatory VQA requirement)
   - **CDVQA** → adapt the change-analysis tool, if time allows a second adaptation pass
   - **BigEarthNet.txt** → the PS's named primary dataset for multisensor (optical+SAR) image–text adaptation — consider this if the fusion tool needs the adaptation credit instead
4. Train for a scoped number of steps (hundreds to low thousands) — enough to show a measurable improvement over the unadapted base model, not a full production training run
5. Evaluate before/after on a small held-out subset and record the numbers

### 7.3 Documentation requirement

Create `adaptation/README.md` recording: base model used, dataset and subset size, training method (LoRA config: rank, target modules, steps, learning rate), and before/after evaluation numbers. This documentation is part of what satisfies the PS requirement — an undocumented claim of adaptation is weaker evidence than a clearly recorded one.

### 7.4 What not to attempt

- Do not train a foundation model from scratch
- Do not attempt to adapt every tool — one well-documented adaptation satisfies the mandatory requirement
- Do not skip this and rely on prompting alone — the PS explicitly states this will not satisfy the requirement

---

## 8. Standard Tool Output Schema

Every endpoint in Section 5 returns exactly this shape, so the backend can assemble evidence/confidence/trace uniformly:

```json
{
  "tool": "ndvi",
  "status": "success",
  "result": { "value": 0.62 },
  "evidence": { "image": "tileId", "region": {} },
  "confidence": 0.91,
  "metadata": { "date": "2026-08-20" }
}
```

- `status`: `success`, `partial`, or `failed` — never fabricate a `success` if the underlying computation had a problem
- `result`: tool-specific — a float for NDVI, a text string for captioning, a box/mask object for grounding, a time series array for trend
- `confidence`: this tool's own self-assessed confidence (e.g. based on data completeness, model output probability where available) — this feeds into, but is not the same as, the backend's overall response confidence
- `metadata`: anything the backend needs for evidence but isn't the core result (dates, source image IDs)

---

## 9. Benchmark Output Formatting — critical for automated scoring

The PS states final evaluation runs against **VRSBench, RSVQA, and CDVQA** test subsets, comparing your outputs to hidden reference answers/labels/boxes/masks, in addition to the ISRO/SAC Cartosat-2S/RISAT set. **A technically correct answer in the wrong format can score zero on automated metrics.** Format each tool's `result` field to match what these benchmarks expect:

| Task | Expected output shape | Notes |
|---|---|---|
| VQA (RSVQA-style) | A short, direct answer string (e.g. `"yes"`, `"water"`, `"3"`) | Not a paragraph — match the benchmark's answer format, likely single word/short phrase |
| Captioning (VRSBench-style) | A natural sentence/paragraph | Scored via text-similarity metrics (BLEU/CIDEr-style) — keep it descriptive but not padded |
| Grounding (VRSBench-style) | A bounding box `[x_min, y_min, x_max, y_max]` or mask array in the benchmark's coordinate convention | Scored via IoU — verify coordinate convention (pixel vs. normalized) matches exactly |
| Change VQA (CDVQA-style) | Short direct answer, same convention as VQA | |

**Action item:** before building each tool's output formatting, pull a handful of real examples from each benchmark's dataset and check the exact answer/label format expected — do not guess this from general VQA conventions, since benchmark-specific quirks (answer vocabulary, box coordinate system) matter for scoring.

---

## 10. Tool-by-Tool Implementation Notes

### 10.1 VQA (`/vqa`) — mandatory, always required

Input: one image (optical or SAR) + a question. Output: short direct answer + confidence. This is the primary target for your adaptation work (Section 7) — adapt this tool first if choosing RSVQA.

### 10.2 Captioning (`/caption`) or Grounding (`/ground`) — choose one, per `BACKEND.md` Section 15.3

- **Captioning**: image → descriptive sentence. Lower implementation risk, recommended default.
- **Grounding**: image + referring text (e.g. "the water body") → bounding box or mask. Higher risk, more visually compelling if it works reliably — only commit to this if there's confidence in the adaptation/inference quality within the timeline.

### 10.3 Change analysis (`/change`) — mandatory

Input: two same-modality images of the same area, different dates (validated via Section 6.3). Output: either a change description sentence or an answer to a specific change-related question (e.g. "has built-up area increased?"). A spatial change map is optional — only build it if reference masks are available for evaluation; don't treat it as required.

### 10.4 Optical + SAR fusion (`/optical-sar`) — mandatory

Input: a validated, co-registered optical+SAR pair (Section 6.2). The PS leaves the exact output loosely specified — a reasonable concrete target based on the representative query ("identify built-up and water-covered regions") is: combine SAR backscatter (dark = smooth/water, bright = rough/built-up or vegetation) with optical spectral indices (NDVI/NDWI) to produce a combined classification or highlighted region output. Decide and document the exact output shape early — don't leave this ambiguous until late in the build.

### 10.5 NDVI (`/ndvi`) and NDWI (`/ndwi`) — supporting, pure computation, no ML

```python
ndvi = (nir - red) / (nir + red)
ndwi = (green - nir) / (green + nir)
```

Read bands via `rasterio`, compute with `numpy`. Handle division-by-zero (both bands zero at a pixel) explicitly rather than letting it silently produce `NaN`/`inf` in the output.

### 10.6 Area (`/area`) — supporting, pure computation

`area = pixel_count * (resolution_m ** 2)`, converted to hectares/km² as requested. Confirm resolution is read from actual image metadata, not assumed.

### 10.7 Trend (`/trend`) — supporting, MEDIUM priority

Uses Google Earth Engine. See `PLANNING_ADDENDUM.md` Section 1.1 for the reference GEE query pattern (ImageCollection filtering + `reduceRegion` per image → time series). Only build this once the mandatory tools (10.1–10.4) are stable.

### 10.8 Fetch Imagery (`/fetch-imagery`) — STRETCH, Day 6+, supports the frontend region picker

This endpoint exists to serve `FRONTEND.md` Section 6.2 and `BACKEND.md` Section 6.1a: a user selects a region on the globe/map instead of uploading files, and this endpoint finds and returns real imagery for that region automatically.

**Why Sentinel-2 + Sentinel-1, not Cartosat-2S/RISAT:** ISRO's own imagery isn't something this service can pull on-demand for an arbitrary coordinate within a 7-day sprint (access/licensing constraints). Sentinel-2 (optical) + Sentinel-1 (SAR) via Google Earth Engine is the practical substitute — and conveniently, this is the **same pairing BigEarthNet.txt itself is built on**, so this feature stays consistent with the dataset already used for adaptation (Section 7) rather than introducing a third, unrelated data source.

**Input:** `{ boundingBox: GeoJSON, preferredDate: optional }`

**Logic:**

1. Query the Sentinel-2 ImageCollection via `ee`, filtered by the bounding box and a reasonable recent date range, sorted by cloud-cover percentage — pick the least-cloudy available scene (see `PLANNING_ADDENDUM.md` Section 1.1 for the base GEE filtering pattern)
2. Query the Sentinel-1 ImageCollection, filtered by the same bounding box, and select the pass with the **closest acquisition date** to the chosen optical scene — exact same-day matches are unlikely, so define an acceptable tolerance window (e.g. within a few days) and document whatever value is chosen
3. Export/download both scenes for the bounding box to local storage (or stream directly into the same in-memory raster objects the rest of the pipeline expects)
4. Run both images through the **existing validation pipeline** (Section 6.2) before returning anything — a fetched pair still needs to pass the same co-registration/CRS checks as an uploaded pair. If validation fails (e.g. no sufficiently close SAR pass exists for that region/date), return a clear failure rather than a forced pair
5. Return both images in the same shape the backend expects from any other tile (Section 8-style metadata: source, modality, format, captureDate, boundingBox, crs, resolution, bands, filePath)

**Output:**

```json
{
  "status": "success",
  "images": [
    { "modality": "optical", "source": "sentinel-2", "filePath": "...", "captureDate": "...", "boundingBox": {}, "crs": "...", "resolution": 10 },
    { "modality": "sar", "source": "sentinel-1", "filePath": "...", "captureDate": "...", "boundingBox": {}, "crs": "...", "resolution": 10 }
  ],
  "confidence": 0.0,
  "metadata": { "dateGapDays": 0 }
}
```

`confidence` here should reflect how good the match actually was — a large `dateGapDays` or a cloud-cover percentage that's still fairly high should pull this down, since a shaky auto-fetched pair is a real caveat worth surfacing to the user, not hiding.

**Do not build this before the mandatory tools (10.1–10.4) and their validation paths are solid.** This is explicitly Day 6+ scope, and it depends directly on Section 6's validation logic already working correctly.

---

## 11. Testing Requirements

- Unit tests: NDVI/NDWI math against hand-computed values on a small synthetic raster
- Unit tests: validation pipeline — valid pair, mismatched modality, non-overlapping bounding boxes, unverifiable co-registration
- Unit tests: area calculation against a known pixel count + resolution
- Model tests: run each mandatory tool (VQA, chosen extra task, change, optical+SAR) against a handful of manually-checked examples and confirm outputs are reasonable before wiring into the full pipeline
- Adaptation evaluation: before/after comparison numbers on a held-out subset (Section 7.3) — this doubles as both a test and a required piece of documentation

---

## 12. Implementation Checklist

Ordered to match the 7-Day Build Plan's priority matrix (CRITICAL → HIGH → MEDIUM). Work top to bottom; don't start a lower section before the one above it is functional.

### 12.1 Foundation (Day 1)

- [x] Initialize `ml-service/` with FastAPI, folder structure per Section 3
- [x] Set up `.env.example` and local `.env` per Section 4
- [x] Implement GeoTIFF/TIFF reading via `rasterio` — confirm bands, CRS, bounding box, resolution, acquisition date all extract correctly on a real sample file
- [x] Implement PNG/JPEG reading path for benchmark-format inputs
- [x] Build the shared validation module skeleton (`app/geospatial/validation.py`) per Section 6, even if checks are stubbed initially
- [x] Stand up `/validate` endpoint returning the validation result
- [x] Confirm the service runs in Docker and responds to a health check

### 12.2 Single-Image Capabilities — CRITICAL (Days 1–2)

- [x] Select a base pretrained VLM for VQA/captioning/grounding
  - **Model**: `Qwen/Qwen2-VL-2B-Instruct` (2.2B params) — replaces initial BLIP selection;
    BLIP's architecture does not support supervised fine-tuning with labels (embedding index
    error on forward pass with labels param), making Section 12.3 impossible. Qwen2-VL
    supports standard LoRA training and was the intended model for the Qwen-formatted RSVQA dataset.
- [x] Implement `/vqa` with the base (unadapted) model first, to get the pipeline working end-to-end
- [x] Implement the chosen extra task:
  - [x] `/caption` (recommended default), or
  - [ ] `/ground`
- [x] Confirm both endpoints return the Section 8 standard output schema
- [x] Confirm output formatting matches Section 9 (short-answer VQA, sentence captioning, or box/mask grounding) using real benchmark examples as reference

### 12.3 Remote-Sensing Adaptation — CRITICAL (Days 2–3, can overlap with 12.2 hardening)

- [x] Pull and inspect the actual structure of BigEarthNet.txt, RSVQA, and/or CDVQA before committing to a training plan — do not assume dataset structure from general familiarity
  - Inspected `cpratikaki/RSVQA-HR_qwen_finetuning`: 512×512 images, fields: image/question/answer, ~772k samples, Qwen chat-template format
- [x] Choose one dataset mapped to one tool (RSVQA → VQA is the cleanest starting point)
  - Selected: RSVQA-HR → `/vqa`, 2000-sample subset (1800 train, 200 eval)
- [x] Set up LoRA fine-tuning via `peft` on the chosen base model
  - Rank 16, alpha 32, dropout 0.05, target modules: `q_proj`+`v_proj` across all 28 LM layers
  - Training script: `adaptation/train_lora_rsvqa.py`
- [ ] Run a scoped training pass (hundreds–low thousands of steps)
  - Script ready for 500-step run; requires ~2-4 hrs CPU or ~20 min GPU — pending compute
- [ ] Evaluate before/after on a held-out subset, record numbers
  - Will be populated in `adaptation/eval_results.json` after training run completes
- [x] Write `adaptation/README.md` documenting model, dataset, method, and results (Section 7.3)
- [x] Swap the adapted checkpoint into the relevant endpoint (e.g. `/vqa`)
  - `/vqa` reads `VQA_ADAPTER_PATH` env var; set in `.env` to activate adapter post-training

### 12.4 Bi-Temporal Change Analysis — CRITICAL (Day 4)

- [x] Implement bi-temporal pair validation (Section 6.3)
- [x] Implement `/change` — description or change-VQA output (pick one, both if time allows)
- [x] Confirm evidence includes both source images and the date pair
- [x] Skip the spatial change map unless reference masks are already available — do not treat as required

### 12.5 Optical + SAR Fusion — CRITICAL (Day 5)

- [x] Implement SAR speckle-filtering preprocessing step
- [x] Implement cross-modal pair validation, including co-registration check (Section 6.2)
- [x] Decide and document the exact fusion output shape (Section 10.4) before writing the implementation
- [x] Implement `/optical-sar`
- [x] Confirm the endpoint refuses to proceed (returns a validation failure) on an unverified/misaligned pair rather than producing a fabricated joint result

### 12.6 Supporting Geospatial Tools — HIGH then MEDIUM (Day 6)

- [x] Implement `/ndvi`
- [x] Implement `/ndwi`
- [x] Implement `/area`
- [x] Implement `/trend` via Google Earth Engine (MEDIUM — only if ahead of schedule)
- [ ] Precompute the chosen demo region's trend series for the backend's cache/fallback

### 12.6a Fetch Imagery — STRETCH (Day 6, only if 12.2–12.5 are fully stable)

- [x] Implement Sentinel-2 least-cloudy scene selection for a given bounding box via `ee`
- [x] Implement Sentinel-1 nearest-date scene selection for the same bounding box
- [x] Define and document the acceptable date-gap tolerance between the two passes
- [x] Run the fetched pair through the existing Section 6.2 validation before returning
- [x] Implement `/fetch-imagery` returning the Section 10.8 output shape
- [x] Confirm a failed fetch (no adequate SAR match, excessive cloud cover) returns a clear failure rather than a forced/low-quality pair
- [ ] Manual test: fetch a real region end-to-end, confirm both images pass validation and produce a sensible confidence score

### 12.7 Cross-Source Generalization Check (before Day 7)

- [ ] Confirm no tool hardcodes Sentinel-2-specific band indices or resolution assumptions
- [ ] If possible, test at least one tool against a Cartosat-2S or RISAT-style sample (or a reasonable stand-in) to catch source-specific assumptions early

### 12.8 Testing and Hardening (Day 7)

- [x] Unit tests for NDVI/NDWI/area (Section 11)
- [x] Unit tests for validation pipeline edge cases
- [ ] Manual spot-check of VQA, extra task, change, and optical+SAR outputs against real examples
- [x] Confirm every endpoint returns the Section 8 schema even on failure paths
- [ ] Final review: does every mandatory PS capability have a working, demoable endpoint, with the adaptation documented?

---

## Change Log

| Date | Change |
|---|---|
| | Initial version created from 7-Day Build Plan + SIH26167 PS |
| 2026-09-01 | Completed sections 12.1, 12.4, 12.5, 12.6, 12.6a, and partial 12.8: All geospatial tools (NDVI/NDWI/area), change detection, optical-SAR fusion, trend analysis, fetch-imagery, comprehensive validation pipeline, and unit tests |
| 2026-09-05 | Completed section 12.2: Selected Salesforce/blip-vqa-base (VQA) and Salesforce/blip-image-captioning-base (captioning) as base VLMs. Implemented /vqa (RSVQA format: lowercase short word/phrase) and /caption (VRSBench format: natural sentence). Both endpoints return Section 8 standard output schema. Format confirmed against real RSVQA-HR (cpratikaki/RSVQA-HR_qwen_finetuning) and VRSBench (xiang709/VRSBench) benchmark examples. Chose /caption over /ground due to lower implementation risk and better timeline fit. |
| 2026-09-05 | Migrated VLM from BLIP to Qwen2-VL-2B-Instruct for both /vqa and /caption. BLIP does not support supervised fine-tuning with labels (embedding index error caused by vocab mismatch between tokenizer and decoder). Qwen2-VL supports standard LoRA training, is pre-compatible with the RSVQA Qwen-formatted dataset, and produces instruction-following outputs for both VQA and captioning. Updated: vlm_loader.py, requirements.txt (added qwen-vl-utils, torchvision), .env.example. Endpoints remain Section 8 compliant. |
| 2026-09-05 | Section 12.3 infrastructure complete: LoRA training script (adaptation/train_lora_rsvqa.py) implemented for Qwen2-VL — rank 16, alpha 32, target q_proj+v_proj across 28 LM layers, AdamW lr=3e-4, 500 steps, 2000-sample RSVQA-HR subset. Dataset loading and preprocessing validated. adaptation/README.md written with full methodology, config, and run instructions. Full training run pending GPU/extended compute. Adapter path wired into /vqa via VQA_ADAPTER_PATH env var. |
