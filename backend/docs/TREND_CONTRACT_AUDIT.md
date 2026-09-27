# Trend Contract & Integrity Audit

Scope: `/api/query/trend`, `/api/query` trend dispatch, the ML `/trend` endpoint,
and the trend analysis core. Backend + ML/core only. No frontend, STAC/provider
acquisition, async, quantization, or external-credential changes.

## 1. Executive summary

Six real defects were found and fixed. The two most serious were not cosmetic
contract gaps — they caused the system to assert conclusions the data did not
support.

1. **A single observation produced `direction: "stable"` and `0.0%` change.**
   One point was reported as a flat trend that was never observed.
2. **The AOI was silently discarded.** The backend set `aoi_geometry` on the
   request, `TrendRequest` had no such field, Pydantic dropped it, and the
   provider was queried over the *whole region* — while the response still
   reported AOI intent.
3. **Region bounds shipped with no CRS.** `west/south/east/north` were
   unlabelled numbers; a consumer could not tell degrees from metres.
4. **A declared non-4326 CRS was reinterpreted, not reprojected.** A polygon
   drawn in UTM metres was read as if its coordinates were degrees.
5. **A second, unreachable trend route existed.** `routes/trend.js` was mounted
   behind `queryRouter`, so it could never run — and it carried a *different*,
   wrong cache-key implementation.
6. **Confidence was a hardcoded heuristic, not a measurement.** The pipeline
   started from a literal `0.5` and treated the real confidence as a small bonus.

## 2. Routes: one authoritative endpoint

`backend/src/index.js` mounted two routers that both claim `POST /api/query/trend`:

```js
app.use('/api/query', queryRouter);      // owns router.post('/trend')
...
app.use('/api/query/trend', trendRouter); // owns router.post('/')
```

`queryRouter` is registered first, so it always handled the request and
`trendRouter` was permanently unreachable. This was latent rather than harmful —
but the dead file was a trap: it hashed only
`{ metric, region, startDate, endDate }`, omitting `interval`, and it would have
silently served a monthly cache entry to a yearly request had it ever run.

**Fixed:** `routes/trend.js` deleted, its import and mount removed. The
authoritative implementation in `routes/query.js` is the only one.

## 3. Region CRS: explicit, not assumed

`/trend` queries GEE via `ee.Geometry(region)`, which reads a bare GeoJSON
geometry as WGS84 lon/lat — so EPSG:4326 is the CRS the service genuinely works
in, and reporting it is traceable rather than invented.

- `region.crs` is now always emitted alongside `region.bounds`.
- `area_units` states "square degrees (EPSG:4326); not a ground area", because
  the previous bare `area_deg2` invited a km² reading.
- A caller may declare `crs` (string, or GeoJSON-style `crs` member). Non-4326
  input is **reprojected** with pyproj before the range checks, so a UTM polygon
  is never misread as degrees.
- Undeclared projected coordinates still fail, but the error now says how to fix
  it instead of just "out of range".
- Bounds of `aoi` and `analyzedRegion` are labelled with the same CRS.

`/trend` opens no raster, so no `isGeoreferenced` or valid-pixel coverage is
reported — nothing was measured.

## 4. AOI: applied, and reported as applied

`TrendRequest` gained `aoi` and `aoi_crs`. `compute_trend` resolves the
intersection *before* the provider call, so the provider is asked about
`region ∩ aoi` and never sees ground outside the applied scope.

- `aoiScope.aoiApplied` is `false` with `aoiScope: "region"` when no AOI was
  supplied — a real distinction, not a silent default.
- With an AOI, `aoiStatus: "applied"` and `analyzedBounds` describe what was
  actually analysed; `requestedBounds` still shows the original region.
- An AOI larger than the region is clipped to it.
- A disjoint AOI is a **validation error**, not an empty series. Falling back to
  the whole region would return numbers for ground the caller did not ask about.
- The backend validates the AOI, forwards it, and includes it in cache identity.
  An AOI-scoped series is never served to an unscoped request or vice versa.

`ml-service/app/tools/roi_crop.py` was not modified.

## 5. Insufficient data

| Valid observations | Reported |
|---|---|
| 0 | `direction: "no-data"`, everything `null` (unchanged) |
| 1 | `direction: "insufficient-data"`, `percentage_change: null`, `slope: null` |
| 2 | comparison values, `sufficient_for_trend: false`, note says it is a comparison |
| 3+ | full trend, `sufficient_for_trend: true` |

`MIN_OBSERVATIONS_FOR_TREND = 3` is a named constant, matching the backend
analyzer's existing threshold.

## 6. Confidence

`trend_confidence` is deterministic and traceable: `1.0` only for real (`gee`)
data with no warnings, no missing periods **and** enough observations to support a
trend; `0.8` otherwise; `0.0` only on failure. A two-point comparison can no
longer report the same confidence as a fitted trend.

In the pipeline, a single-tool `TREND` query now reports the confidence the ML
service actually computed. The generic `estimateConfidence` heuristic is still
recorded in the trace as a signal, but its hardcoded `0.5` base is no longer what
the client is told.

## 7. Result contract

`backend/src/utils/trendResultNormalizer.js` gives `/api/query` and
`/api/query/trend` one shape: `region` + `regionCrs`, `analyzedRegion`,
`aoiScope`/`aoiApplied`, `dateRange`, `series`, `observations` (quality-annotated),
`qualityCounts`, `trend` (ML statistics), `trendStats` (analyzer statistics),
`anomalies`, `warnings`, `sufficientForTrend`, `observationCount`, `confidence`.

It is **strictly additive** — the ML service's `series` is preserved byte-for-byte,
so the exact-match cache tests and existing clients are unaffected, and no field
is invented. Unmeasured values stay `null` or absent.

### A cache-fidelity bug this surfaced

MongoDB does not persist `{}`. The analyzer emits `metadata: {}` per observation,
so a **cache hit returned a structurally different payload than the cache miss
that produced it**. Fixed by pruning empty objects (empty *arrays* are kept —
`anomalies: []` and `warnings: []` mean "checked, found none" and must not become
"absent"). The pre-existing assertion that a hit equals its miss is now satisfied
by the payload rather than weakened.

## 8. Cache identity

`findCoveringCacheEntry` was missing three conditions:

- `tool: 'trend'` — another tool's entry sharing metric/region/dateRange could be
  served as a trend.
- `expiresAt: { $gt: new Date() }` — the TTL index reaps documents
  asynchronously, so a read could still match an expired entry.
- the AOI key.

`toolExecutor.js` stored `interval` but never filtered on it, so a monthly
request could be served a yearly series. Both paths now filter on it.

`parameters` is unchanged (`{region, metric, startDate, endDate, interval}`); the
AOI scope travels in the dedicated `aoiKey` field that already existed on the
model.

## 9. Provider degradation and error semantics

Preserved and verified: unavailable GEE returns an explicit `failed` ToolOutput
with `confidence: 0` and no observations; nothing is cached; no fallback invents
a series. The precomputed demo fallback remains region-locked, interval-matched
and labeled, and mock-labeled results are never cached as real data.

## 10. Tests

New:
- `ml-service/tests/test_trend_contract.py` — 18 tests (CRS, reprojection, AOI
  application, disjoint AOI, 0/1/2/3+ semantics, confidence tiers)
- `backend/tests/trend-contract.test.js` — 22 tests (route uniqueness, cache
  identity, AOI forwarding, result contract, honesty)

Updated:
- `ml-service/tests/test_trend.py` — `test_insufficient_observations_single_point`
  asserted `percentage_change == 0.0` from **one** observation, i.e. it encoded
  the bug. It now asserts `None` and `direction == "insufficient-data"`, plus two
  new tests for the 2- and 3-observation cases. This is a strengthening.

## 11. Results

| Suite | Before | After |
|---|---|---|
| Backend | 442 passed / 33 suites | **464 passed / 34 suites** |
| ML | 459 passed | **479 passed** |

No existing test was weakened, skipped or removed.

## 12. Not changed (by design)

Frontend, STAC/provider acquisition, async, quantization,
`ml-service/app/tools/roi_crop.py`, `backend/src/agents/answerComposer.js`
(consumer-side), the general AOI/ROI layer, and the completed georeference work.
