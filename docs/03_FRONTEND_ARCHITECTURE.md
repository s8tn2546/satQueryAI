# SatQuery AI — Frontend Architecture & Component File Breakdown

## 1. Overview & Tech Stack

The frontend is a single-page React application built with **Vite** and styled using **Tailwind CSS** with CSS variables for a frosted-glass (`backdrop-filter: blur(24px)`) visual design system.

- **Framework**: React 18
- **Build System**: Vite
- **3D Globe Engine**: CesiumJS (`cesium`)
- **Icons**: Lucide React (`lucide-react`)
- **Charts**: Recharts (`recharts`)
- **Styling**: Tailwind CSS + Custom Dark Theme (`#060913` base canvas)

---

## 2. Directory Structure

```
frontend/src/
├── main.jsx                 # React entry point
├── App.jsx                  # Main layout & state orchestrator
├── App.css                  # App global layout styles
├── index.css                # Global CSS variables & Tailwind directives
├── lib/
│   ├── api.js               # Axios HTTP client for backend endpoints
│   ├── results.js           # Result transformation & formatting utilities
│   └── utils.js             # Spatial math, area formatting & class merging
├── Components/
│   ├── GlobeView.jsx        # Cesium 3D Globe centerpiece & AOI overlay
│   ├── SearchBar.jsx        # Floating query composer & image attachment bar
│   ├── ResultsPanel.jsx     # Trust layer display (Answer, Evidence, Trace, KPIs)
│   ├── Sidebar.jsx          # Session chat history & new analysis trigger
│   ├── TopBar.jsx           # Header bar, telemetry readouts & basemap picker
│   ├── SpectralProfileView.jsx # Multi-spectral reflectance graph
│   ├── TrendChart.jsx       # Historical time-series chart (Recharts)
│   ├── SatQueryLogo.jsx     # SVG brand logo component
│   ├── BorderBeam.jsx       # Animated glowing border component
│   ├── SidebarIcon.jsx      # SVG icon wrapper
│   └── ui/                  # Reusable low-level UI elements
│       ├── Input.jsx
│       ├── MenuToggleIcon.jsx
│       └── ShaderSearchIcon.jsx
└── landing/                 # Marketing landing page & Auth views
    ├── App.tsx
    ├── pages/ (Home.tsx, Login.tsx)
    └── components/
```

---

## 3. File-by-File Breakdown

### Core Application Entry & Shell

- **`src/main.jsx`**: Initializes the React DOM root and mounts `<App />`. Imports global CSS (`index.css`).
- **`src/App.jsx`**: Main application state orchestrator. Manages:
  - `queryResult`: Active query response object.
  - `isLoading`: Boolean loading indicator during backend processing.
  - `activeSessionId`: Anonymous UUID for current user session.
  - `attachedTiles`: Currently uploaded satellite rasters.
  - `roiAttachment`: Bounding box coordinates drawn on the globe.
  - Controls sidebar drawer collapse/expand and delegates queries to `src/services/api.js`.
- **`src/index.css`**: Configures Tailwind directives, custom glassmorphism utility classes (`.glass-panel`, `.glass-button`), CSS variables for color tokens, and Cesium viewport container fixes.

### Component Layer (`src/Components/`)

- **`GlobeView.jsx`**:
  - Initializes the **Cesium.Viewer** canvas.
  - Renders 11 selectable satellite basemaps (Bing, Esri, NASA Blue Marble, OpenStreetMap).
  - Handles globe auto-rotation when idle, dragging interaction, and camera altitude constraints.
  - Implements **AOI / Draw ROI**: draws cyan translucent polygon entities (`#06B6D4`) with center area labels upon rectangle drag-release.
  - Syncs camera view to uploaded satellite tile bounding boxes.

- **`SearchBar.jsx`**:
  - Floating bottom query composer panel.
  - Supports natural-language text input and keyboard shortcuts (`Enter` to submit).
  - Contains image attachment controls allowing drag-and-drop or file browser upload of GeoTIFF/TIFF rasters.
  - Displays ROI scope badge when an AOI polygon is active on the globe.

- **`ResultsPanel.jsx`**:
  - Translucent right-side overlay presenting the complete **Trust Layer**:
    1. *Header & KPI Strip*: Task type badge, confidence score indicator, ROI scope banner.
    2. *Answer Card*: Formatted text response.
    3. *Visual Evidence Viewer*: Raster preview, band metadata, co-registration details.
    4. *Execution Step Trace*: Chronological audit trail of agent steps.
    5. *Interactive Visualizations*: Mounts `TrendChart.jsx` or `SpectralProfileView.jsx` when applicable.
    6. *Intelligence Report Exporter*: Button to download structured GEOINT reports.

- **`Sidebar.jsx`**:
  - Left navigation drawer listing persistent session query history.
  - Allows clicking past queries to restore previous results.
  - Contains "New Analysis" button to clear state and reset globe view.
  - Displays user profile card stub.

- **`TopBar.jsx`**:
  - Header bar across the top of the viewport.
  - Displays live cursor telemetry (Latitude, Longitude, Altitude).
  - Hosts basemap switcher dropdown and application title.

- **`TrendChart.jsx`**:
  - Recharts line-chart component rendering historical NDVI/NDWI values over time (2018–2026).

- **`SpectralProfileView.jsx`**:
  - Renders spectral reflectance curves across optical bands (B2 Blue, B3 Green, B4 Red, B8 NIR).

### Utilities & API Services (`src/lib/` & `src/services/`)

- **`src/services/api.js`**:
  - Axios wrapper calling Express backend endpoints (`/api/query`, `/api/images/upload`, `/api/query/history`).
  - Handles multipart file uploads and sets default timeouts (600s).

- **`src/lib/utils.js`**:
  - Exports `cn()` helper for Tailwind class merging.
  - Exports `calculateGeographicAreaKm2()` for spherical polygon surface area calculations using Haversine formulas.
  - Exports `formatGeographicArea()` for human-readable $km^2$ / $m^2$ strings.

- **`src/lib/results.js`**:
  - Formats raw API responses into structured layout props for `ResultsPanel.jsx`.
