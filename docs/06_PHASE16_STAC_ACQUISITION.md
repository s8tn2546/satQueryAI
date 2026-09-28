# Phase 16 — STAC Satellite Acquisition (Scene Search + AOI-Only Ingest)

Status: **DONE** — all suites green, live provider test run with real data.
Backend `npm test`: **35 suites / 476 passed**. ML `pytest`: **519 passed**.
Live Earth Search smoke test: **RUN** (real Sentinel-2 COG fetched out of the scene, `mock: false`, validation `valid`).

---

## 1. Objective

Provide SatQuery with real satellite data acquisition: discover scenes from a
live STAC catalog, then acquire **only the requested area of interest (AOI)** of
a chosen scene as a local analysis GeoTIFF plus a derived RGB preview, persist it
as a Tile, and deduplicate identical acquisitions. Backend + ML service only.

Two new public endpoints:

- `POST /api/stac/search` → `POST /stac/search` (ML) — scene discovery.
- `POST /api/stac/ingest` → `POST /stac/ingest` (ML) — AOI-only acquisition + Tile persist.

## 2. Scope and boundaries (explicit)

- **No frontend changes.** UI integration is a follow-up.
- **No synthetic data ever labelled as real.** Fixture scenes are always
  `mock: true` with a stated reason; offline mode raises instead of fabricating.
- **No reprojection.** The analysis raster keeps the scene's native CRS;
  requesting a different `targetCrs` fails explicitly (`ReprojectionUnsupportedError`),
  it is never silently transformed.
- **AOI-only acquisition.** Fetch uses COG windowed reads (range requests), never
  a full-scene fallback; the scope is reported `cog-window-read`.
- **No credentials in source code.** Provider endpoint/client id come only from
  the environment.

## 3. What existed before

- `backend/src/routes/images.js` had `POST /api/images/fetch-by-region` that used
  a backend-side mock/gee-client path (kept intact and untouched).
- A duplicate/legacy `backend/src/routes/fetch-imagery.js` was mounted at
  `/api/images/fetch-by-region` as well — stale and now **deleted**; the
  authoritative route remains `images.js`.
- No STAC client, provider abstraction, or satellite acquisition endpoints existed
  in the ML service.

## 4. Catalog verification (live, no credentials)

Verified before designing against them, not guessed:

| Catalog | Endpoint | Collections confirmed |
|---|---|---|
| Earth Search | `https://earth-search.aws.element84.com/v1` | `sentinel-2-l2a`, `sentinel-2-l1c`, `sentinel-2-c1-l2a`, `landsat-c2-l2` |
| Planetary Computer | `https://planetarycomputer.microsoft.com/api/stac/v1` | `sentinel-2-l2a`, `landsat-c2-l2` |

Concrete real items used throughout verification:

- `S2A_43RGL_20250331_1_L2A` (sentinel-2a, native EPSG:32643)
- `LC08_L2SP_146041_20250428_02_T1` (landsat-8)

Asset-name ground truth (this session, live item dump):

- Sentinel-2 L2A COG family assets are named by common name: `blue`, `green`,
  `red`, `nir`, `nir08`, `nir09`, `rededge*`, `swir16`, `swir22`, `visual`. The
  same band also exists as a legacy `*-jp2` asset (e.g. `red-jp2`) with identical
  `eo:bands` common names but credential-bound `s3://` hrefs — the origin of the
  role-collision bug fixed below (§14).
- Landsat C2 L2 assets are named `coastal`, `blue`, `green`, `red`, `nir08`, ...,
  carry `eo:bands.common_name`, and are Cloud-Optimized (`image/tiff`) with
  anonymous HTTPS hrefs.

## 5. Provider layer (`ml-service/app/services/satellite_provider.py`)

A `SatelliteProvider` ABC with three honest implementations selected by
`get_provider(mode)`:

| Provider | `STAC_MODE` | Behaviour |
|---|---|---|
| `StacSatelliteProvider` | `real` / unset | Live `pystac_client` against `STAC_API_URL`; COG windowed reads. |
| `OfflineSatelliteProvider` | `offline` | Raises `ProviderUnconfiguredError` for every operation; never fabricates. |
| `FixtureSatelliteProvider` | `mock`/`test`/`dev` | Deterministic labelled fixtures, always `mock: true` + `FIXTURE_REASON`. |

Honesty rules enforced in the module:

- Collection configs were derived from live catalog responses, never guessed.
- Provider identifiers (item id, collection) are preserved verbatim.
- `is_fixture` class attribute drives `mock` labelling everywhere.
- A scene without usable CRS metadata fails rather than guessing a CRS.

Registry (verified asset role map):

```
sentinel-2-l2a: blue→blue, green→green, red→red, nir→nir    (10 m COGs)
landsat-c2-l2 : blue→blue, green→green, red→red, nir→nir08   (30 m COGs)
```

Role resolution prefers `eo:bands.common_name`, falling back to the registry by
exact asset-name match; it is never position-based.

## 6. AOI-only acquisition (windowed COG read)

`fetch_scene_aoi`:

1. Re-resolves scene metadata from the provider (client-supplied ids are never
   trusted verbatim).
2. Verifies each requested role has a usable asset.
3. Opens the first usable COG and uses **its own** CRS/transform/bounds as ground
   truth (never the caller's).
4. Transforms the AOI into the asset CRS explicitly, verifies intersection with
   the footprint (else `SceneNoIntersectionError`).
5. Reads only the intersecting window (`from_bounds` + `round_offsets().intersection(...)`),
   clamping to the raster extent; reports `scope: cog-window-read`.

## 7. Search endpoint

`POST /api/stac/search` (`StacSearchRequest`): sensor/collection, `dateRange`
(start < end, not future, ≤ 30 years), AOI/Polygon, optional `cloudMax` (0–100),
`limit` (1–100). Returns normalized scene summaries with provider identifiers,
cloud cover, band roles, and a clear `mock`/`reason`/`warnings` block plus
provider labels. Empty results are a valid answer, not a failure.

## 8. Ingest endpoint

`POST /api/stac/ingest` (`StacIngestRequest`): collection, `sceneId`, AOI,
optional `bands` (default blue/green/red/nir) and `targetCrs` (must equal native
CRS). Acquires the AOI, writes:

- **Analysis raster** — native CRS/geotransform GeoTIFF, band descriptions set to
  the real provider asset names so downstream band resolution matches native files.
- **RGB preview** — percentile 2–98 stretch PNG, only when blue/green/red were all
  acquired; otherwise `None`, never fabricated.
- Runs the existing validation pipeline on the analysis raster.
- Computes the deterministic `dedupeKey` (see §9).

## 9. Dedupe strategy

Dedupe key (deterministic, no randomness, JSON-stable):

```
stac:{provider}:{collection}:{scene_id}:{canonical_aoi_json}:{sorted_roles}:{target_crs}
```

- `canonical_aoi_json` rounds coordinates to 6 decimals with `sort_keys`.
- `target_crs` = the scene's native CRS (`scene.crs or window.crs`).
- The backend stores it on `Tile.dedupeKey` with a **unique sparse index** and
  returns the existing tile instead of re-ingesting (§11, incl. the E11000 lesson).

## 10. Backend persistence — Tile model

`backend/src/models/Tile.js` extended (legacy fields untouched):

- `source` enum + `'landsat-8'`, `'landsat-9'`.
- Provenance: `provider`, `sceneId`, `collection`, `analysisRaster`, `previews`
  (png/channels/stretch), `aoi`, `aoiCrs`, `dedupeKey`.

`deriveSource(platform)` maps `sentinel*→sentinel-2`, `landsat-8*→landsat-8`,
`landsat-9*→landsat-9`; **unknown platforms → 422 with nothing persisted**.

## 11. The `dedupeKey` default/null trap (fixed)

A sparse unique index does index documents where the field exists with value
`null`. An initial model with `dedupeKey: { type: String, default: null }` made
**every legacy tile** collide (E11000; 45 failing tests). Fixed by removing the
default so the field is simply absent on non-STAC tiles. This is a fragile
MongoDB footgun and must not be reintroduced.

## 12. Backend routes and service wiring

- `backend/src/routes/stac.js` — `POST /search`, `POST /ingest`: validate, proxy
  to ML via `mlServiceClient.callMlService('/stac/{search,ingest}')`, 422 on
  unknown platform or missing dedupeKey, dedupe before persisting, return
  `publicTile` (never exposes server-internal paths).
- `backend/src/routes/tiles.js` — preview surfaced (`hasPreview`, `renderable`,
  `previews`), `GET /:id/preview`, and `GET /:id/image` serves the derived preview
  for TIFF sources with one (415 only when neither source nor preview exists).
- `backend/src/index.js` — mounted at `/api/stac`; stale `/api/images/fetch-by-region`
  mount removed; `src/routes/fetch-imagery.js` deleted.
- `backend/src/services/mlServiceClient.js` — added offline `unavailableResult`
  cases for both `/stac/*` endpoints (reported `status: 'failed'`), consistent
  with every other endpoint's offline honesty.

## 13. Failure modes (all explicit, none silent)

| Condition | Result |
|---|---|
| No live provider (`STAC_MODE=offline`) | `failed`, confidence 0.0, "No live satellite provider is configured." |
| Unsupported sensor/collection | `failed`, "Unsupported ...", lists supported collections |
| Invalid/mis-labelled AOI or CRS | `failed` (parse/interp error surfaced) |
| Missing band for the scene | `BandUnavailableError` / `StacValidationError` |
| AOI misses the scene footprint | `SceneNoIntersectionError` |
| `targetCrs` ≠ native CRS | `ReprojectionUnsupportedError` |
| Empty search window | valid empty result + explanatory warning |
| Window fetched but contains only nodata | validation fails honestly (`all-nodata`) — observed live, see §14 |

## 14. Bugs found and fixed during the live run (evidence)

1. **Role collision on real catalogs.** Earth Search exposes each band twice
   (COG tiff + legacy `-jp2`, same common names), and `visual`/`visual-jp2`
   composites list `red,green,blue`. The probe therefore chose `TCI.jp2`
   (credential-bound `s3://`) or the composite. Fix: `_normalize_item` now
   ignores composite assets and prefers the Cloud-Optimized tiff (`_cog_rank`)
   when several assets share a role. Verified live: the probe resolves to
   `.../S2A_43RGL_20250331_1_L2A/B04.tif` (anonymous HTTPS COG).
2. **`hrefs` dict bug.** `fetch_scene_aoi` built `hrefs={b.asset: ...}` on
   `SceneAsset` objects (attribute is `name`). Fixed to `b.name`.
3. **All-nodata window is caught honestly.** The first live AOI sampled the
   bottom-left quarter of granule `..._1_L2A` (granule 1 covers the tile's upper
   band) → the windowed read returned only nodata and validation produced
   `[Raster contains only nodata values across all bands]`. Re-sampled the top of
   the tile → validation `valid`. This is the validation pipeline working as
   designed on real data.

## 15. Environment / configuration

`ml-service/.env.example` STAC block:

- `STAC_API_URL` (default Earth Search), `STAC_MODE` (`real`/`offline`/`test`),
  `STAC_PROVIDER`, `STAC_CLIENT_ID`, `STAC_CLIENT_SECRET`, `ACQUISITION_DIR`
  (default `./acquisitions` relative to cwd; git-ignored).

`backend/.env.example` notes that STAC config lives on the ML side.

`requirements.txt` now includes `pystac` and `pystac_client`.

## 16. Test evidence

- **ML `tests/test_stac.py`** (+40): search/ingest validation, date/cloud filters,
  fixture labelling (`mock`+reason), offline clarity, unsupported collection,
  unknown band, `targetCrs` mismatch, AOI-only ingest (hash + band descriptions =
  real asset names + preview + validation contract), no NaN/Infinity in responses,
  the full degenerate `_normalize_item` matrix (COG > jp2, composite skip,
  registry fallback). Net ML suite: **519 passed**.
- **Backend `tests/stac-routes.test.js`** (+12): search request validation +
  proxying + ML-failure mapping; ingest validation, tile persistence with full
  provenance, sentinel/landsat source derivation, **dedupe returns the existing
  tile (one document)**, unknown platform → 422 with nothing persisted, offline →
  `failed`, preview & image serving for geotiffs. Net backend suite:
  **35 suites / 476 passed**.

## 17. Live provider test (this session)

Anonymous Earth Search run, `mock: false`, source `stac`:

```
get_scene_metadata → S2A_43RGL_20250331_1_L2A (mock: false)
search_scenes      → count 10  | mock: false | source: stac
                     scenes: S2B_43RGL_20250324_0_L2A,
                             S2C_43RGL_20250329_0_L2A,
                             S2A_43RGL_20250331_1_L2A ...
probe COG          → .../S2A_43RGL_20250331_1_L2A/B04.tif   (anonymous https)
ingest_scene       → mock: false | scope: cog-window-read | crs: EPSG:32643
                     bands: ['blue','green','red','nir']
                     window 2745x2745 (~60 MB, AOI-only — NOT the full scene)
                     validation: valid | preview: PNG | dedupeKey: stac:...:EPSG:32643
```

Sentinel-2 L2A items advertise `s3://` hrefs for legacy assets; the anonymous
COG family uses `https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/`.
The smoke script used only address-level verification; **no product code rewrites
any href**.

## 18. Honesty rulebook (summary)

1. Fixture data is always `mock: true` with a stated reason — never scientific.
2. Offline mode raises; it never returns made-up scenes or confidence.
3. Confidence is deterministic: fixture 0.7; real with warnings 0.8; real clean 1.0.
4. CRS/geometry are never inferred — absent CRS or unparsable AOI CRS fails.
5. Band identity is never assumed from position or band number.
6. A preview is created only from bands actually acquired; otherwise `None`.
7. The window scope is reported as `cog-window-read`, never a polygon mask.
8. Reprojection is not claimed; mismatches fail explicitly.

## 19. Known limitations / follow-ups

- **Frontend wiring** for `/api/stac/search` + `/api/stac/ingest` is not done.
- **Reprojection** (`targetCrs` ≠ native) is an explicit failure, not supported yet.
- **Validation on huge windows** now confirms `valid` on real data, but window
  size limits/caching for the UI are future work.
- **Planetary Computer** catalog is a planned secondary endpoint (client-id
  optional) — verified at the catalog level; the default remains Earth Search.
- Analysis raster band descriptions use real asset names (`blue`/`green`/`red`/
  `nir` / `nir08`...); downstream analytics resolve bands by description/registry —
  already consistent with native-file behaviour.

## 20. Files touched

```
ml-service/app/services/satellite_provider.py   new provider layer (+ fixes)
ml-service/app/tools/stac.py                    new orchestration (search/ingest)
ml-service/app/api/stac.py                      new endpoints
ml-service/app/schemas/requests.py              Stac*Request schemas
ml-service/app/main.py                          router registration (tag stac-acquisition)
ml-service/tests/test_stac.py                   new tests (+40)
ml-service/requirements.txt                     pystac, pystac_client
ml-service/.env.example                         STAC block
backend/src/routes/stac.js                      new route (search/ingest/dedupe)
backend/src/models/Tile.js                      provenance fields + sparse unique dedupeKey
backend/src/routes/tiles.js                     preview surface + endpoints
backend/src/routes/images.js                    ALLOWED_SOURCES += landsat-8/landsat-9
backend/src/services/mlServiceClient.js         offline /stac/* cases
backend/src/index.js                            mount /api/stac, drop stale mount
backend/src/routes/fetch-imagery.js             DELETED (stale duplicate)
backend/tests/stac-routes.test.js               new tests (+12)
backend/.env.example                            note: STAC config on ML side
.gitignore                                      ml-service/acquisitions/
```

## 21. Review checklist

- [x] Real catalog verified live (collections, asset names, item ids).
- [x] No synthetic data labelled as real; fixture labelling enforced by `is_fixture`.
- [x] Offline mode fails clearly; confidence never invented.
- [x] AOI-only windowed COG read; scope honestly reported.
- [x] Analysis raster in native CRS; band descriptions = real asset names.
- [x] Preview only from acquired channels; otherwise `None`.
- [x] Dedupe deterministic and enforced server-side (sparse unique index, no default).
- [x] Unknown platform → 422, nothing persisted.
- [x] No credentials in source, config through environment only.
- [x] Full suites green: backend 476, ML 519.
- [x] Live provider smoke: RUN, real data, `mock: false`, validation `valid`.