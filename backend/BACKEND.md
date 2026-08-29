# SatQuery AI — Backend Implementation Guide

**This is the authoritative backend reference for this repo. Refer to this document before implementing any backend feature. If anything here conflicts with the SIH Problem Statement (SIH26167), the Problem Statement wins.**

---

## 1. Role and Scope

The backend (Node.js + Express) is the **orchestrator**, not the analysis engine. It does not touch raster pixels, run models, or compute NDVI/NDWI/masks directly. Its job is:

1. Accept requests from the frontend (queries, image uploads)
2. Run the **agentic pipeline**: classify intent → validate inputs → select tool(s) from the registry → call the ML service (Python/FastAPI) → collect results
3. Assemble the **evidence + confidence + execution trace** for every response
4. Persist state to MongoDB (users, queries, tiles, cache, tool registry metadata)
5. Return a single, structured response to the frontend

**Everything that touches actual pixels, models, or geospatial computation belongs in the Python/ML service, not here.** If you find yourself writing raster logic in Node, stop — that's a sign the task belongs in the ML service instead.

---

## 2. Tech Stack

| Component | Choice |
|---|---|
| Runtime | Node.js |
| Framework | Express |
| Database | MongoDB (Mongoose or native driver) |
| Auth (low priority) | JWT + bcrypt |
| LLM integration | Anthropic or OpenAI SDK, used for intent classification and answer composition only |
| Inter-service calls | HTTP (axios or fetch) to the Python/FastAPI ML service |
| Containerization | Docker (this service gets its own Dockerfile, orchestrated via root `docker-compose.yml`) |

---

## 3. Folder Structure

```
backend/
  src/
    agents/         # orchestration pipeline: intent classifier, planner, executor
    routes/         # Express route definitions
    services/       # MongoDB access, ML-service HTTP client, cache logic
    models/         # Mongoose schemas (User, Query, Tile, ResultsCache, ToolRegistry)
    middleware/      # auth, error handling, request validation
    utils/           # shared helpers (evidence/trace builders, response formatting)
  tests/
  package.json
  Dockerfile
  .env.example
```

---

## 4. Environment Variables

Create `.env.example` with (do not commit real secrets):

```
PORT=
MONGODB_URI=
JWT_SECRET=
ML_SERVICE_BASE_URL=
LLM_API_KEY=
LLM_PROVIDER=
NODE_ENV=
```

---

## 5. Data Model (MongoDB)

### 5.1 `users`

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `name` | String | |
| `email` | String | unique index |
| `passwordHash` | String | bcrypt, low priority for this sprint |
| `createdAt` | Date | |
| `preferences` | Object | default region, units |

### 5.2 `queries`

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `userId` | ObjectId | optional if auth is deprioritized — allow anonymous for demo |
| `queryText` | String | raw user question |
| `inputRefs` | Array\<ObjectId\> | references to uploaded image(s) used |
| `taskType` | String | `VQA`, `CAPTION`, `GROUNDING`, `CHANGE_ANALYSIS`, `OPTICAL_SAR`, `NDVI`, `NDWI`, `AREA`, `TREND` |
| `toolsInvoked` | Array\<String\> | tool names called, in order |
| `parameters` | Object | extracted parameters (region, dateRange, metric, etc.) |
| `result` | Object | structured result from the ML service |
| `evidence` | Object | see Section 9 |
| `confidence` | Number | 0–1 |
| `executionTrace` | Array\<Object\> | see Section 9 |
| `answerText` | String | final natural-language answer |
| `status` | String | `success`, `partial`, `failed`, `rejected` (validation failure) |
| `createdAt` | Date | |

### 5.3 `tiles` / `images`

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `source` | String | `sentinel-2`, `bhuvan`, `cartosat-2s`, `risat`, `benchmark-upload`, `gee-fetch` (region-based acquisition, Section 6.1a) |
| `modality` | String | `optical`, `sar` |
| `format` | String | `geotiff`, `tiff`, `png`, `jpeg` |
| `captureDate` | Date | null if unavailable (e.g. benchmark PNGs) |
| `boundingBox` | GeoJSON Polygon | 2dsphere indexed; null if unavailable |
| `crs` | String | null if unavailable |
| `resolution` | Number | meters/pixel, null if unavailable |
| `bands` | Array\<String\> | |
| `filePath` | String | |
| `validated` | Boolean | result of the validation pipeline |
| `validationDetails` | Object | see Section 11 |

### 5.4 `results_cache`

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `metric` | String | `ndvi`, `ndwi`, etc. |
| `region` | GeoJSON | 2dsphere indexed |
| `dateRange` | `{ start: Date, end: Date }` | |
| `series` | Array\<`{ date, value }`\> | |
| `interval` | String | `monthly`, `yearly` |
| `computedAt` | Date | |

### 5.5 `tool_registry`

Mirrors the Python service's tool definitions so the agent can reason over them without a network call on every request. Sync this on startup or via an admin endpoint.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `name` | String | e.g. `vqa`, `caption`, `ground`, `change`, `optical_sar`, `ndvi`, `ndwi`, `area`, `trend` |
| `description` | String | used by the LLM for tool selection |
| `requiredInputs` | Array\<String\> | e.g. `["optical_image"]`, `["optical_image", "sar_image"]` |
| `acceptedModalities` | Array\<String\> | |
| `parameters` | Object | schema of accepted parameters |
| `endpoint` | String | ML service route, e.g. `/vqa` |
| `outputSchema` | Object | |

---

## 6. API Endpoints (Client-facing, Node/Express)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Create account (low priority) |
| POST | `/api/auth/login` | Issue JWT (low priority) |
| POST | `/api/images/upload` | Accept single image or a pair; runs validation; returns `tileId`(s) + validation result |
| POST | `/api/query` | Main entry point: `{ queryText, imageRefs: [tileId, ...] }` → runs the full agent pipeline, returns the structured response (Section 9) |
| POST | `/api/query/trend` | Historical trend query: `{ region, metric, startDate, endDate }` → two-phase cache resolution |
| GET | `/api/query/:id` | Retrieve a past query's full result + trace (for the report download / history view) |
| GET | `/api/query/:id/report` | Generate and return a downloadable report (PDF or structured doc) bundling answer + evidence + confidence + trace |
| GET | `/api/query/history` | List past queries (per user if auth is enabled, otherwise per session) |
| GET | `/api/tools` | List the tool registry (useful for frontend debugging / admin view) |
| POST | `/api/images/fetch-by-region` | STRETCH — region-based acquisition (Section 6.1a): `{ boundingBox: GeoJSON }` → fetches optical + SAR imagery for the region, returns `tileId`(s) in the same shape as `/api/images/upload` |

**`POST /api/query` response shape (this is the contract the frontend depends on):**

```json
{
  "answerText": "string",
  "taskType": "VQA | CAPTION | GROUNDING | CHANGE_ANALYSIS | OPTICAL_SAR | NDVI | NDWI | AREA | TREND",
  "result": { "...": "tool-specific structured output" },
  "evidence": { "images": ["tileId"], "region": {}, "notes": "string" },
  "confidence": 0.0,
  "executionTrace": [ { "step": "string", "detail": "string" } ],
  "status": "success | partial | failed | rejected"
}
```

### 6.1a Region-Based Image Acquisition (STRETCH — Day 6+, only after mandatory pipeline is stable)

This supports the frontend's globe/map region picker (see `FRONTEND.md` Section 6.2). It is an **acquisition** step, not an agent tool — it runs before the query pipeline, not as part of it, and its whole purpose is to produce the same `tileId`s that a direct upload would produce, so nothing downstream needs to know how the images arrived.

**Flow:**

1. Frontend sends a bounding box (drawn from the globe/map selection) to `POST /api/images/fetch-by-region`
2. Backend calls a new ML-service endpoint (`/fetch-imagery` — see `ML_SERVICE.md`) with that bounding box
3. The ML service finds and returns a cloud-free-ish optical pass and a temporally-close SAR pass covering that region (via Google Earth Engine, Sentinel-2 + Sentinel-1 — see rationale in `ML_SERVICE.md`)
4. Backend stores each returned image as a `tiles` document (Section 5.3), with `source: "gee-fetch"` and `validated` set based on whatever validation the ML service already ran on the fetched pair
5. Backend returns `tileId`s in **exactly the same response shape as `/api/images/upload`**

**Why this matters architecturally:** the agent pipeline (Section 7) and every tool downstream should never need a special case for "this image was fetched vs. uploaded" — by the time a `tileId` reaches the query pipeline, it's indistinguishable from a direct upload. If you find yourself adding an `if (source === 'gee-fetch')` branch anywhere past this acquisition step, that's a sign the abstraction has leaked and needs fixing.

**Do not build this before the mandatory capabilities (Sections 7, 15.2–15.4) are working against direct uploads.** This is explicitly a Day 6+ item.

---

## 7. Agent Orchestration Pipeline

Implemented in `src/agents/`. This is the core of the backend. Steps, in order:

1. **Intent classification** — LLM function-calling call: given `queryText` + metadata about the uploaded image(s) (count, modality), classify into one of the supported task types and extract parameters (region, date range, metric, question focus).
2. **Input inspection & validation** — check the uploaded image(s) against what the classified task requires (see Section 11). If validation fails, **do not proceed** — return a `rejected` status with a clear explanation.
3. **Task planning** — determine the ordered list of tools needed. Most queries need one tool; some (e.g. "use optical and SAR together to find built-up and water regions") may need validation + fusion in sequence.
4. **Tool selection** — match against `tool_registry` entries, not hardcoded if/else chains.
5. **Parameter extraction** — fill each selected tool's required parameters from what the LLM extracted in step 1.
6. **Tool execution** — call the ML service endpoint(s) via `services/mlServiceClient.js`. Support sequential calls when a task needs more than one tool.
7. **Result validation** — check the ML service didn't return an error or empty/malformed result before trusting it.
8. **Evidence aggregation** — collect which image(s), region, and tool outputs back the answer.
9. **Confidence estimation** — combine signals: did validation pass cleanly? did the tool report its own confidence? was data complete (no missing dates/cloud gaps for trend queries)? Produce a single 0–1 score plus the underlying signal list.
10. **Answer generation** — LLM call that takes the structured tool result + evidence and produces the natural-language answer. **The LLM must not introduce any number or claim that isn't present in the tool result.**
11. **Execution trace assembly** — log every step above (task type, tools called, parameters used, status) in the format from Section 9.

**Note on scope, per the PS:** only the *observable* execution trace (task, tools/models, parameters, outputs) is evaluated — the LLM's internal reasoning text is not required or scored. Do not over-invest in making the agent "explain its thinking" — invest in making the structured trace complete and accurate.

---

## 8. Tool Registry Format

Each tool the agent can call is described exactly like this (mirrors the ML service's own registry — keep both in sync):

```json
{
  "name": "calculate_ndvi",
  "description": "Calculate vegetation index from multispectral imagery",
  "required_inputs": ["optical_image"],
  "accepted_modalities": ["optical"],
  "parameters": { "region": "optional" },
  "endpoint": "/ndvi",
  "output_schema": { "value": "float", "map": "raster" }
}
```

Tools to register at minimum (per the mandatory PS scope):

| Tool name | Endpoint | Maps to PS capability |
|---|---|---|
| `vqa` | `/vqa` | Single-image VQA (mandatory) |
| `caption` | `/caption` | Single-image additional task, option A |
| `ground` | `/ground` | Single-image additional task, option B |
| `change` | `/change` | Bi-temporal change (mandatory) |
| `optical_sar` | `/optical-sar` | Cross-modal pair analysis (mandatory) |
| `ndvi` | `/ndvi` | Supporting tool |
| `ndwi` | `/ndwi` | Supporting tool |
| `area` | `/area` | Supporting tool |
| `trend` | `/trend` | Supporting tool, MEDIUM priority |

---

## 9. Evidence, Confidence, and Execution Trace — exact schemas

### Standard tool output (expected from the ML service, passed through by the backend)

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

### Execution trace entry (one per pipeline step, stored as an array on the query)

```json
{
  "step": "tool_selection",
  "detail": "Selected tools: [validate_pair, optical_sar]",
  "timestamp": "ISO-8601"
}
```

### Final response confidence signals (what feeds the 0–1 score)

- Input validation passed without warnings → +
- Tool reported its own high confidence → +
- Cross-modal pair fully co-registered → +
- Missing/partial data (e.g. cloud gaps in a trend series) → −
- Fallback or partial tool failure → −

Document the exact weighting your team lands on in this file once decided — don't leave it implicit in code only.

---

## 10. Caching Strategy (results_cache)

Applies mainly to `/api/query/trend`, but the pattern generalizes to any expensive/repeatable computation.

**Phase 1 (fast path):** query `results_cache` for a matching `{ region, metric, dateRange }` (exact match or a coverable superset). If found, return immediately.

**Phase 2 (cache miss):** call the ML service's `/trend` endpoint, then write the result into `results_cache` before responding, so future overlapping queries hit the fast path.

Precompute and cache the chosen demo region's results ahead of time — this cache also serves as the offline/live-demo fallback.

---

## 11. Validation Responsibilities (backend-owned checks before calling the ML service)

The backend should reject clearly invalid requests **before** spending a call on the ML service:

- File format is GeoTIFF/TIFF, or PNG/JPEG **only if** the request is flagged as a benchmark-dataset evaluation
- For a task requiring a pair (change, optical+SAR): exactly two images provided, both present
- Modality matches what the task needs (e.g. optical+SAR fusion needs one of each modality, not two of the same)
- If geospatial metadata is present (GeoTIFF case): CRS is readable, bounding boxes are present for both images in a pair
- **Do not attempt actual co-registration verification in Node** — that's raster-level work and belongs in the ML service. The backend's job is to confirm the *inputs are structurally suitable for* that check, then trust the ML service's validation result.

If validation fails, return `status: "rejected"` with a clear, specific reason — never silently proceed with a mismatched pair.

---

## 12. Error Handling and Fallback

- If the ML service call fails or times out: return `status: "failed"` with a clear message — do not let the LLM answer-composer invent a plausible-sounding result to cover the gap.
- If the query is outside supported scope entirely (no matching intent): return a fallback response stating what the system *can* answer, listing the supported task types.
- Every error path should still produce a valid response shape (Section 6) so the frontend doesn't need special-case handling for failures.

---

## 13. Authentication (Low Priority for This Sprint)

Implement only if the mandatory capabilities (Sections 6–11) are stable. Minimal version:

- `POST /api/auth/register` — bcrypt hash the password, store in `users`
- `POST /api/auth/login` — verify password, issue a JWT
- Middleware to attach `userId` to requests when a valid JWT is present; **allow anonymous queries** if not, so the demo never breaks on missing auth

---

## 14. Testing Requirements

- Unit tests: intent classification against the five representative PS queries (see Section 15 checklist) and a few edge/out-of-scope queries
- Unit tests: validation logic (valid pair, mismatched modality, missing metadata, wrong format)
- Integration test: full `/api/query` round trip against a mocked ML service response, checking the response shape matches Section 6 exactly
- Integration test: cache hit vs cache miss path for `/api/query/trend`

---

## 15. Implementation Checklist

Use this as a running task list. Work top to bottom within each section; sections are ordered by priority (CRITICAL → HIGH → MEDIUM → LOW), matching the 7-Day Build Plan. Check items off as completed — do not skip ahead within a section unless explicitly noted.

### 15.1 Foundation (Day 1)

- [ ] Initialize `backend/` with Express, folder structure per Section 3
- [ ] Set up `.env.example` and local `.env` per Section 4
- [ ] Connect to MongoDB, confirm connection on startup
- [ ] Create Mongoose schemas: `users`, `queries`, `tiles`, `results_cache`, `tool_registry` (Section 5)
- [ ] Seed `tool_registry` collection with the 9 tools listed in Section 8
- [ ] Implement `POST /api/images/upload` — accept file, store metadata as a `tiles` document, return `tileId` (validation logic can be a stub initially)
- [ ] Set up `services/mlServiceClient.js` — a thin HTTP client wrapper for calling the Python service, with timeout and error handling
- [ ] Stub `POST /api/query` — accept request, return a hardcoded response matching the Section 6 shape (to unblock frontend integration early)

### 15.2 Core Agent Pipeline — CRITICAL (Days 2–3)

- [ ] Implement intent classification via LLM function-calling, using the `tool_registry` entries as the function/tool definitions
- [ ] Test intent classification against all five PS representative queries:
  - [ ] "Describe the land-cover and major objects visible in this image." → `CAPTION`
  - [ ] "Highlight the water body referred to in the query." → `GROUNDING`
  - [ ] "What changed between these two dates, and where did the change occur?" → `CHANGE_ANALYSIS`
  - [ ] "Use the optical and SAR images together to identify built-up and water-covered regions." → `OPTICAL_SAR`
  - [ ] "Has the built-up area increased, decreased, or remained unchanged?" → `CHANGE_ANALYSIS` (VQA-style)
- [ ] Implement input inspection/validation logic (Section 11) — structural checks only
- [ ] Implement task planning + tool selection against the registry (no hardcoded if/else)
- [ ] Implement parameter extraction from the classified query
- [ ] Implement tool execution — single tool call working end-to-end against the ML service
- [ ] Implement multi-tool sequencing (needed for tasks like optical+SAR: validate → fuse)
- [ ] Implement result validation (catch ML service errors/empty results before trusting them)
- [ ] Implement evidence aggregation (Section 9 format)
- [ ] Implement confidence estimation logic (Section 9 signal list) — document the weighting used
- [ ] Implement answer generation LLM call — verify it never introduces numbers not present in the tool result (spot-check manually)
- [ ] Implement execution trace assembly and attach to every `queries` document
- [ ] Wire the full pipeline into `POST /api/query`, replacing the Day 1 stub
- [ ] Implement the honest fallback path for out-of-scope queries

### 15.3 Mandatory Capability Wiring — CRITICAL (Days 2–5, alongside ML service readiness)

- [ ] Wire `vqa` tool call end-to-end (single image + question → answer)
- [ ] Wire chosen single-image extra task end-to-end — **decide and check one:**
  - [ ] `caption` (recommended default)
  - [ ] `ground` (only if ML team has bandwidth)
- [ ] Wire `change` tool end-to-end (bi-temporal pair → change description or change VQA)
- [ ] Wire `optical_sar` tool end-to-end (validated pair → fused result)
- [ ] Confirm every one of the above returns evidence + confidence + trace, not just a bare answer

### 15.4 Trust Layer Surfacing — CRITICAL

- [ ] Confirm `GET /api/query/:id` returns full stored result including trace
- [ ] Implement `GET /api/query/:id/report` — bundle answer + evidence + confidence + trace into a downloadable format
- [ ] Confirm every response, including failure/rejected paths, matches the Section 6 response shape exactly

### 15.5 Supporting Geospatial Tools — HIGH then MEDIUM (Day 6)

- [ ] Wire `ndvi` tool end-to-end
- [ ] Wire `ndwi` tool end-to-end
- [ ] Wire `area` tool end-to-end (MEDIUM)
- [ ] Implement `POST /api/query/trend` with two-phase cache resolution (Section 10) (MEDIUM — only if ahead of schedule)
- [ ] Precompute and cache the chosen demo region's trend result as a fallback

### 15.5a Region-Based Image Acquisition — STRETCH (Day 6, only if 15.2–15.4 are fully stable)

- [ ] Confirm the ML service's `/fetch-imagery` endpoint is ready (check `ML_SERVICE.md`)
- [ ] Implement `POST /api/images/fetch-by-region`
- [ ] Store fetched images as `tiles` documents with `source: "gee-fetch"`
- [ ] Confirm the response shape exactly matches `/api/images/upload`'s response
- [ ] Confirm no downstream code (agent pipeline, tools) branches on how an image was acquired
- [ ] Manual test: fetch a region, then run a full query against it end-to-end through the normal pipeline

### 15.6 Auth — LOW (only if time remains)

- [ ] `POST /api/auth/register`
- [ ] `POST /api/auth/login`
- [ ] JWT middleware, with anonymous fallback preserved

### 15.7 Testing and Hardening (Day 7)

- [ ] Unit tests for intent classification (Section 14)
- [ ] Unit tests for validation logic
- [ ] Integration test for full `/api/query` round trip
- [ ] Integration test for trend cache hit/miss
- [ ] Confirm every error path returns a valid, frontend-safe response shape
- [ ] Final review: does every mandatory PS capability have a working, demoable path through this backend?

---

## Change Log

Update this section whenever a decision in this document changes, so the team (and repo history) has a clear record.

| Date | Change |
|---|---|
| | Initial version created from 7-Day Build Plan + SIH26167 PS |
