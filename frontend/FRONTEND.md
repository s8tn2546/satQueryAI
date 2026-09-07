# SatQuery AI — Frontend Implementation Guide

**This is the authoritative frontend reference for this repo. Refer to this document before implementing any UI feature. If anything here conflicts with the SIH Problem Statement (SIH26167), the Problem Statement wins. Where this document conflicts with `BACKEND.md`'s API contract, `BACKEND.md` wins — the frontend consumes that contract, it does not define it.**

---

## 1. Role and Scope

The frontend (React) is the only part of the system a judge or user directly touches. Its job:

1. Accept image uploads (direct file upload — required, scored) and/or a map-picked region (auto-fetch — stretch feature, see Section 7)
2. Send natural-language queries to the backend and render the structured response
3. Display the **trust layer** (answer, evidence, confidence, execution trace) as clearly as the answer itself — this is a scored requirement, not a design nicety
4. Provide the visual identity of the product: the rotating Earth centerpiece, the expandable chat panel, the sidebar

**This layer does not classify intent, validate images, or compute anything.** If a UI feature needs actual computation (parsing a GeoTIFF, checking co-registration), that request goes to the backend — the frontend only renders what comes back.

---

## 2. Tech Stack

| Component | Choice | Purpose |
|---|---|---|
| Build tool | Vite | Fast dev server, PWA plugin support |
| Framework | React | |
| 3D globe | Cesium.js | Interactive 3D globe centerpiece with tile loading & location controls |
| Styling | CSS Variables + Tailwind CSS | Unified glassmorphic design system |
| State management | React State / Context | Chat state, session ID, active query result |
| HTTP | `axios` or `fetch` wrapper | Calls to the Node backend only — never call the ML service directly |

---

## 2.1 Design System Tokens & Visual Language

All UI surfaces in SatQuery AI derive from a single dark, glassmorphic visual language. Panels read as frosted glass (translucent-but-not-transparent) to ensure high text legibility over 3D globe imagery.

### Tokens Reference

| Category | Token | Value / Style | Description |
|---|---|---|---|
| **Color** | App Base Background | `#060913` | Deep space dark navy global canvas background |
| **Color** | Glass Panel Background | `rgba(15, 23, 42, 0.62)` | Translucent ultra-frosted glass background |
| **Color** | Glass Panel Border | `1px solid rgba(255, 255, 255, 0.12)` | Crisp glowing glass border |
| **Color** | Primary Accent Gradient | `linear-gradient(135deg, #6EB4FF 0%, #3B7DDD 100%)` | Blue gradient for primary buttons & status accents |
| **Color** | Text Primary | `#F1F5F9` | High-contrast cool white body and heading text |
| **Color** | Text Secondary / Muted | `#94A3B8` | Muted slate gray for labels and metadata |
| **Color** | Status Indicator | `#34D399` | Emerald green active/online status dot |
| **Effect** | Backdrop Blur | `backdrop-filter: blur(24px)` | High-precision frosted glass blur across panels |
| **Effect** | Glass Shadow | `0 20px 48px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.1)` | Ambient drop shadow + inner top-edge highlight |
| **Typography** | Font Family | `'Space Grotesk', system-ui, sans-serif` | Clean geometric sans-serif |
| **Typography** | Section Labels | `10px`, uppercase, `letter-spacing: 1.2px`, muted `#94A3B8` | Section dividers like "CURRENT SESSION" |
| **Shape** | Border Radius | `12px` – `18px` | Rounded corners for cards, floating controls, and sidebar |

---

## 3. Folder Structure

```
frontend/
  src/
    components/
      globe/            # Earth component, auto-rotate + drag controls, region-select overlay
      sidebar/           # chat history list, new chat button, profile
      chat/              # collapsed chat button, expanded chat panel, message list
      results/           # answer, evidence viewer, confidence display, execution trace, trend chart
      upload/            # direct file upload flow
      map-picker/         # region selection map (Leaflet), paired with the globe
    hooks/
    services/            # API client wrapping calls to the Node backend
    state/               # session/chat state management
    styles/
  public/
    earth-textures/       # public-domain Earth texture assets
  package.json
  vite.config.js
```

---

## 4. Core Interaction Design

### 4.1 The rotating Earth centerpiece — functional, not decorative

- Renders centered on the main screen using `react-three-fiber`
- **Idle state**: auto-rotates slowly
- **User interaction**: dragging with the mouse rotates it manually; auto-rotation pauses while dragging and resumes after a short idle period
- **Functional role**: the globe doubles as the entry point for the map-based region picker (Section 7) — zooming/clicking into a region on the globe is the primary "pick a location" interaction, rather than a separate disconnected flat map. A flat React-Leaflet map can appear as a precision step after an initial globe selection, for accurate bounding-box drawing.

### 4.2 Sidebar

- New chat button
- Chat history list — keyed by a client-generated anonymous session ID (Section 5.2), not by a logged-in user, since auth is LOW priority this sprint
- Profile section — can be a placeholder/stub if auth isn't implemented yet; do not block the sidebar on auth being ready
- Any other navigation (settings, about) as needed, kept minimal

### 4.3 Chat button → expanded panel

- Collapsed state: a single button, bottom-center
- On click (or on focusing the input): expands into a translucent overlay window containing the input box and the results layout (Section 4.4)
- Collapsing back to the button state should be available at any time without losing the current result

### 4.4 Expanded panel sections — this is the scored surface, structure it deliberately

The PS requires the solution to return "evidence-grounded textual and visual results" including "confidence information, execution summaries, and downloadable reports" — this is not just a nice layout, it's covering a scored requirement. Structure the expanded panel with these distinct sections, in this order:

| Section | Content | Backend field it maps to |
|---|---|---|
| **Answer** | The natural-language response | `answerText` |
| **Visual evidence** | The image(s) with overlays — masks, bounding boxes (grounding), change highlights, fusion output | `evidence`, `result` (task-dependent) |
| **Confidence** | The score, ideally with a short breakdown of what backed it | `confidence` |
| **Execution trace** | Task type, tools/models used, key parameters — collapsible/expandable, not shown in full by default | `executionTrace` |
| **Trend** (when relevant) | Chart of the time series, only shown for `TREND`-type responses | `result.series` |
| **Download report** | Button that calls `GET /api/query/:id/report` | — |

**Note on the execution trace display specifically:** per the PS, only the *observable* trace (task, tools/models, parameters, outputs) is evaluated — the agent's internal reasoning text is not required or scored. Design this section to show the structured trace steps cleanly (a short list or stepper, matching the `BACKEND.md` trace format), not as a wall of freeform reasoning text.

---

## 5. State and Session Management

### 5.1 No blocking on auth

Since authentication is LOW priority in `BACKEND.md`, the frontend must work fully without a logged-in user. Do not gate chat, history, or any core feature behind a login screen.

### 5.2 Anonymous session identity

- On first load, generate a session ID client-side (e.g. a UUID) and persist it in memory/state for the session
- Send this session ID with every `/api/query` call so the backend can group history even without real auth
- If/when auth is added later, this session ID can be migrated to a `userId` — design the API calls to pass an identifier generically (`sessionId` or `userId`, whichever is available) rather than hardcoding an assumption that a user is logged in

### 5.3 Active query state

- Track the current query's full response object (matching the `BACKEND.md` Section 6 shape) in state, so all panel sections (answer, evidence, confidence, trace, trend) render from one consistent object
- Track a loading/pending state distinctly from an error/rejected state, so the UI can show a clear "still analyzing" indicator vs. an honest "this couldn't be processed" message (matching the backend's fallback/rejected responses)

---

## 6. Input Paths — both required, sequenced by priority

### 6.1 Direct file upload — REQUIRED, build first

- Accepts GeoTIFF/TIFF (primary) and PNG/JPEG (benchmark-format inputs only)
- Supports single image, or selecting two images for a pair (cross-modal or bi-temporal — let the user indicate which, or infer from context/metadata returned by the backend's validation step)
- Calls `POST /api/images/upload`, displays the returned validation result (accepted / rejected with reason) before allowing a query against it
- **This path must work independently of the globe/map picker** — it's what the automated benchmark evaluation and the private ISRO/SAC dataset will effectively exercise, so it cannot be secondary or hidden behind the flashier picker

### 6.2 Map/globe-based region picker with auto-fetch — STRETCH FEATURE, build after Section 6.1 and after mandatory backend/ML capabilities are stable

- User selects a region via the globe/map (Section 4.1)
- Frontend sends the selected bounding box to a new backend/ML endpoint (to be added to `ML_SERVICE.md`/`BACKEND.md`) that fetches a cloud-free optical pass and a temporally-close SAR pass for that region (via Google Earth Engine, Sentinel-2 + Sentinel-1)
- Once fetched, the returned image references flow into the same query pipeline as a direct upload — **this path should terminate in the same data shape as Section 6.1**, not a separate code path through the rest of the app
- Do not begin building this until the mandatory single-image, change, and optical+SAR capabilities are working end-to-end against direct uploads

---

## 7. Visual Evidence Rendering Details

- **Masks/change highlights**: render as a semi-transparent colored overlay on top of the base image
- **Bounding boxes (grounding)**: render as a rectangle overlay with the referenced label, positioned per the coordinate convention the ML service returns (confirm pixel vs. normalized coordinates with `ML_SERVICE.md` Section 9 before implementing)
- **Trend charts**: `recharts` line chart, x-axis as date, y-axis as the metric value, matching the `series` array shape from the backend
- Keep all evidence visuals inside the "Visual evidence" section (Section 4.4) — don't scatter result visuals across multiple unrelated parts of the panel

---

## 8. What Not to Build First

- Full authentication/login flow
- PWA polish and offline support
- The map/globe auto-fetch pipeline (Section 6.2) — flashy, but not scored, and risks eating time needed for the required upload path and result rendering
- Elaborate animations beyond the core globe rotation and panel expand/collapse
- Query history search/filtering beyond a simple chronological list

One fully working, clearly-structured result panel (Section 4.4) against direct uploads is worth more than a beautiful globe with no working evidence/confidence/trace display behind it.

---

## 9. Testing Requirements

- Component test: expanded panel renders all six sections correctly given a mock `/api/query` response
- Component test: rejected/failed response states render the honest fallback message, not a broken or blank panel
- Manual check: globe auto-rotates when idle, pauses and rotates on drag, resumes after idle timeout
- Manual check: upload flow correctly surfaces a validation rejection (e.g. mismatched pair) rather than silently proceeding
- Manual check: execution trace section displays the structured steps cleanly, without needing to expand a large text blob to find them

---

## 10. Implementation Checklist

Ordered to match the 7-Day Build Plan and to keep the required capabilities ahead of the visual centerpiece features. Work top to bottom within each section.

### 10.1 Foundation (Day 1)

- [x] Initialize `frontend/` with Vite + React, folder structure per Section 3
- [ ] Set up the API client (`services/`) pointed at the Node backend with persistent session ID
- [x] Build the basic app shell: sidebar, topbar, search composer, results panel
- [x] Stub the expanded results panel rendering answer, visual evidence, confidence, and trace

### 10.2 Core Chat + Result Rendering — CRITICAL (Days 2–3, parallel with backend/ML work)

- [ ] Wire the chat input to `POST /api/query` API endpoint
- [x] Render the **Answer** section from `answerText`
- [x] Render the **Visual evidence** section with interactive layer controls (Optical, Bounding Boxes, Segmentation Mask)
- [x] Render the **Confidence** section from `confidence` metric & model metadata
- [x] Render the **Execution trace** section as a clean structured list/stepper
- [ ] Render the **Trend** section conditionally for `TREND`-type responses using `recharts`
- [x] Wire the **Download report** button to generate & download GEOINT Intelligence Reports
- [x] Implement loading, ready, and active query states

### 10.3 Direct Upload Flow — CRITICAL (Days 2–4)

- [x] Build the file upload UI supporting single image and pair selection (SearchBar attachments)
- [ ] Wire to `POST /api/images/upload` endpoint
- [ ] Display client-side pre-upload validation results (format/resolution check)
- [x] Confirm upload path works fully independent of the globe/map picker

### 10.4 Sidebar and History (Day 4–5)

- [x] Implement chat history list in sidebar with interactive session switching
- [x] Implement "new analysis" clearing the active state
- [x] Add profile card stub (Aryan Kumar / aryan@satquery.ai)

### 10.5 Rotating Earth Centerpiece (Day 5–6)

- [x] Implement 3D Cesium globe centerpiece with 11 high-res imagery basemaps (Google, Bing, Esri, NASA, Sentinel)
- [x] Implement idle auto-rotation
- [x] Implement drag-to-rotate, pausing auto-rotation while dragging and resuming after idle timeout
- [x] Camera altitude clamps (1,000m to 25,000,000m) and custom Home-button reset view
- [x] Fullscreen mode support with native window stretch & dark background fix

### 10.6 Map/Globe Region Picker + Auto-Fetch — STRETCH (Day 6, only if mandatory items above are stable)

- [x] Capture camera latitude & longitude coordinates in real-time in TopBar
- [ ] Implement region bounding box selection on the globe
- [ ] Wire the selected region to the fetch-imagery endpoint

### 10.7 Polish and PWA (Day 7, only if time remains)

- [x] Visual polish pass on glassmorphic design system, sidebar logo, and search composer
- [x] Responsive layout polish for mobile viewports (`@media (max-width: 640px)`)
- [x] Add `vite-plugin-pwa` manifest and service worker configuration
- [ ] Test install flow on a real device

---

## Change Log

| Date | Change |
|---|---|
| 2026-09-08 | Updated design tokens, Cesium globe controls, report exporter, visual evidence overlays, and checklist status. |
