# Georeference & Raster Integrity Audit

Scope: `ml-service/` geospatial layer and `backend/` upload pipeline. No frontend
changes. AOI/ROI, LLM, VLM and mock-fallback honesty work was already complete
and was not reopened.

## The problem

SatQuery claims real-world units — area in km², AOI crops, ground resolution,
change area. Those numbers are only meaningful if the raster is actually
georeferenced. Two failure modes were found:

1. **Fabricated spatial values.** Rasterio does not refuse a file that has no
   geotransform. It substitutes the identity matrix and, from it, derives
   `resolution = (1, 1)` and pixel-index "bounds" that look like plausible
   degrees. Code that read those values directly would report a confident
   coordinate for an image that has no location at all.
2. **Invalid files entering analysis.** The upload path defaulted
   `validated: true` whenever the ML service was unreachable, so a corrupt or
   empty file was recorded as verified and only failed — or was quietly
   papered over by a mock result — much later, inside analysis.

## The contract

A raster is georeferenced **only** when it has both a defined CRS *and* a
usable geotransform. Anything less means coordinates are unavailable, and
unavailable is reported as unavailable — never defaulted.

### Integrity categories

| Category | Meaning | Where it may be used |
| --- | --- | --- |
| `visual_only_valid` | Readable, not georeferenced | VQA, caption, NDVI/NDWI, change (pixel counts) |
| `georeferenced_analysis_ready` | Readable, CRS + usable transform | Everything, including area, AOI, real-world area |
| `invalid` | Unreadable, corrupt, or impossible structure | Nothing — must not reach analysis |
| `unverified` | Container checked but never decoded (backend only) | Held pending a real decode |

A CRS alone is not enough, and neither is a transform alone. Both must be
present *and* the transform must not be degenerate.

## What was already correct

Left untouched, verified by test:

- `read_metadata` already refused to report identity-implied values.
- `roi_crop.py` already hard-rejected non-georeferenced input for AOI crops.
- Area resolution guards, change alignment checks, and the optical-SAR
  two-georeferenced-input requirement were already in place.
- NDVI/NDWI were already pixel-domain and correct for non-georeferenced input.
- Dimension and band-count validation was already enforced.

## Changes

### `ml-service/app/geospatial/raster_io.py`

- **Scoped warning suppression.** `rasterio.errors.NotGeoreferencedWarning` is
  suppressed only inside `open_raster`, and only for that one warning class.
  Genuine warnings and all errors still propagate.
- **`_is_real_geotransform()`.** New guard. Rejects the identity matrix
  rasterio substitutes, and also degenerate transforms with zero or non-finite
  pixel size. The latter was a genuine bug found during this work: a transform
  with `pixel size = 0` produced `bounds = {west: 100, east: 100}` and
  `resolution = 0.0`, which flowed downstream as a real zero-area footprint.
- **`get_bounds()` / `get_resolution()`** now raise `NotGeoreferencedError`
  instead of returning implied values.
- **`classify_raster()`** assigns exactly one integrity category, with a
  human-readable `reason` for the non-obvious cases.

### `ml-service/app/geospatial/validation.py`

`run_validation` reports `is_georeferenced` and `integrity` on every path,
derived from the same observed metadata, so `/validate` and `classify_raster`
cannot disagree.

### `ml-service/app/schemas/common.py`

`ValidateResult` gained nullable `is_georeferenced` and `integrity`.

### `ml-service/app/common/http_utils.py`

`spatial_metadata()` builds one standardized block for `ToolOutput.metadata`:

```json
{
  "isGeoreferenced": false,
  "crs": null,
  "resolution": null,
  "width": 8,
  "height": 8,
  "bandCount": 4,
  "bounds": null,
  "dataQuality": "not_requested",
  "spatialMetadataUnavailable": "The raster is not georeferenced ..."
}
```

When `isGeoreferenced` is `false`, an explanation is included so a consumer
does not read the nulls as a bug and fall back to assuming EPSG:4326. Bi-modal
results get an `images` map with each input's own facts, because two images can
differ and collapsing them to one claim would misreport.

It now also accepts a `ValidateResult` shape, so `/validate` publishes the same
block plus the `wgs84Bounds` kept separate from the native-CRS extent.

### Endpoint coverage

`spatial_metadata` is now published by `/validate`, `/ndvi`, `/ndwi`, `/area`,
`/change`, `/optical-sar`, `/vqa` and `/caption`.

`/vqa` and `/caption` are visual-only and open the raster through the shared
AOI layer, so their spatial facts were already computed and merely buried in a
nested block; surfacing them required no new raster I/O.

`/trend` and `/fetch-imagery` are region-based and never open a raster, so
there is no raster georeference to report. **Known limitation, not fixed here:**
`/trend` returns `result.region.bounds` with no accompanying `crs`, while
WGS84 is assumed for GEE queries. A caller supplying a polygon in UTM metres
gets numerically-UTM bounds that read as lon/lat. That is a mislabeling hazard
worth a follow-up, but fixing it means changing the region contract, which is
outside this scope.

### `backend/src/routes/images.js`

- `validateWithMlService` treats a real ML `result.valid` as authoritative.
- When ML cannot answer, a local magic-byte check runs. It only proves the file
  *is plausibly* a container, so success is recorded as `integrity:
  'unverified'` with an explicit `unverifiedReason` — never as verified.
- `validated` is no longer optimistically `true`.
- `valid: false` from ML rejects the upload before any `Tile` is created.
- `integrity` and `isGeoreferenced` propagate to the tile.

### `backend/src/models/Tile.js`

Added nullable `isGeoreferenced` and `integrity` fields.

## Deliberately not changed

- **A truncated-but-correctly-signed file passes the local fallback.** A
  magic-byte check cannot detect truncation; only a decoder can. The file is
  therefore marked `unverified` rather than `valid`, and the ML service remains
  the authority whenever it is reachable. Tightening this would mean decoding
  rasters in the backend, which duplicates the ML service's job.
- **`answerComposer.js`** was modified in the earlier honesty task and is
  explicitly out of scope here.
- **Frontend** was out of scope.

## Verification

| Suite | Before | After |
| --- | --- | --- |
| `backend` | 434 passed / 32 suites | **442 passed / 33 suites** |
| `ml-service` | 421 passed | **459 passed** |

New coverage: `ml-service/tests/test_georeference_integrity.py` (23),
`ml-service/tests/test_spatial_metadata_contract.py` (15),
`backend/tests/upload-integrity.test.js` (8).

The full georeference matrix is asserted behaviourally: valid georeference,
missing CRS, CRS with identity transform, CRS with degenerate transform, plain
PNG, corrupt TIFF, truncated TIFF, corrupt PNG, and empty file — each checked for
its category, its published metadata, and that no spatial accessor invents a
value.

## Note on test fixtures

`backend/tests/geo-integration.test.js` uploaded `Buffer.from('png-bytes')` and
expected HTTP 200. That passed only because the old code defaulted
`validated: true` regardless of content. The fixture was replaced with a real
decodable 1×1 PNG so the test still verifies its actual intent — that the local
fallback accepts a valid raster when ML is unreachable — rather than
documenting the bug. No assertion was weakened.
