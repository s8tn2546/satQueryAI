import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

const ML_SERVICE_BASE_URL = process.env.ML_SERVICE_BASE_URL || 'http://localhost:8000';
// Per-call timeout in ms. Env-tunable (ML_SERVICE_TIMEOUT_MS) without code
// changes. Default is 600000ms: safe for cold-start CPU VLM inference
// (Qwen2-VL + LoRA measured ~200s cold / ~117s warm on a CPU-only Mac). A
// timed-out call falls back to a clearly-labeled mock result — callers must
// treat metadata.mock results as labeled data, never real (the trend route
// never caches them).
const DEFAULT_TIMEOUT = Number(process.env.ML_SERVICE_TIMEOUT_MS) || 600000;

/**
 * Multipart (file-stream) transport definition for Geo/RS endpoints that accept
 * uploaded files (FastAPI UploadFile/File). Maps each backend payload path key to
 * the ML service's expected multipart field name(s).
 *
 * The backend never sends raw host file paths as JSON to the ML service — files
 * live on the backend's own disk and are streamed here as multipart uploads.
 */
const FILE_ENDPOINTS = {
  '/validate': { sourceKeys: ['image_path'], fileFields: ['file'] },
  '/ndvi': { sourceKeys: ['image_path'], fileFields: ['file'] },
  '/ndwi': { sourceKeys: ['image_path'], fileFields: ['file'] },
  '/area': { sourceKeys: ['image_path'], fileFields: ['file'] },
  '/vqa': { sourceKeys: ['image_path'], fileFields: ['image'] },
  '/caption': { sourceKeys: ['image_path'], fileFields: ['image'] },
  '/change': { sourceKeys: ['image_t1_path', 'image_t2_path'], fileFields: ['image1', 'image2'] },
  '/optical-sar': { sourceKeys: ['optical_path', 'sar_path'], fileFields: ['optical_image', 'sar_image'] },
};

// Payload keys that are metadata (IDs) rather than request parameters and should
// not be forwarded as form fields. File path keys are handled separately.
const NON_FORM_KEYS = new Set([
  'image_path', 'image_t1_path', 'image_t2_path', 'optical_path', 'sar_path',
  'tile_id', 'tile_id_t1', 'tile_id_t2', 'optical_tile_id', 'sar_tile_id',
  'imageRefs', 'aoi_requested'
]);

function isFileEndpoint(endpoint) {
  const clean = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return Object.prototype.hasOwnProperty.call(FILE_ENDPOINTS, clean);
}

/**
 * Stream a backend-local file as a multipart upload to the ML service.
 */
async function sendMultipart(url, endpoint, payload, options, signal) {
  const cfg = FILE_ENDPOINTS[endpoint.startsWith('/') ? endpoint : `/${endpoint}`];
  const form = new FormData();

  // Attach each file under the ML service's expected field name.
  for (let i = 0; i < cfg.sourceKeys.length; i++) {
    const filePath = payload[cfg.sourceKeys[i]];
    if (filePath && typeof filePath === 'string') {
      try {
        const buf = await fs.readFile(filePath);
        const name = path.basename(filePath);
        form.append(cfg.fileFields[i], new Blob([buf]), name);
      } catch (err) {
        console.warn(`[MLServiceClient] Could not read local file "${filePath}" for multipart upload to ${endpoint}: ${err.message}`);
      }
    }
  }

  // Forward remaining scalar/JSON request parameters (band indices, thresholds,
  // feature_type, modality_hint, question, etc.) but drop path/ID metadata keys.
  for (const [key, value] of Object.entries(payload)) {
    if (NON_FORM_KEYS.has(key) || value === undefined || value === null || value === '') continue;
    if (typeof value === 'object') {
      form.append(key, JSON.stringify(value));
    } else {
      form.append(key, String(value));
    }
  }

  return fetch(url, {
    method: 'POST',
    body: form,
    signal
  });
}

/**
 * AOI report for an offline mock.
 *
 * A mock never opens the pixels, so it can never have applied an AOI. These
 * fixtures are whole-scene placeholders; saying otherwise would let a
 * "scoped" claim survive on fabricated data. The report says so explicitly so
 * callers and the UI cannot mistake a mock for AOI-scoped analysis.
 */
function mockAoiReport(payload) {
  const requested = Boolean(payload?.aoi_geometry);
  // Deliberately does not name a cause: the same report is used whether the ML
  // service was unreachable or the endpoint does not exist. What is always true
  // is that no pixels were read, so no AOI could have been applied.
  return {
    aoiPresent: requested,
    aoiApplied: false,
    aoiScope: null,
    aoiStatus: requested ? 'not_applied_mock_offline' : 'not_requested_mock_offline',
    reason: requested
      ? 'This is an offline result. No pixels were read and the requested AOI was NOT applied.'
      : 'This is an offline result. No pixels were read.'
  };
}

/**
 * Endpoints the ML service does not implement at all.
 *
 * These are never attempted over the wire: a request would only produce a 404
 * and then a fallback, which is indistinguishable from a real outage and hides
 * the fact that the capability simply does not exist.
 */
const UNIMPLEMENTED_ENDPOINTS = new Set(['/ground']);

/**
 * Build a result that is honest about having computed nothing.
 *
 * Every scientific field is `null` rather than a plausible number. A mock that
 * reports `mean: 0.64` is worse than no answer at all: the number looks
 * measured, flows into charts and summaries, and is indistinguishable from a
 * real observation unless every consumer happens to check `metadata.mock`.
 *
 * `result` mirrors the real ML schema key-for-key so that a consumer reading
 * `result.mean` gets `null` ("not computed") instead of a missing key that
 * could be mistaken for a different code path, and so real and mock results
 * stay structurally interchangeable.
 *
 * `status: 'failed'` is deliberate. Nothing was computed, so 'success' would be
 * a false claim; 'failed' is already in the persisted status vocabulary
 * (`pipeline.js` `persistableToolResults`) and drives the honest `partial`
 * query status and the failure treatment in the UI.
 */
function unavailableResult({ tool, reason, result = {}, evidence = {}, notComputed = [] }) {
  return {
    tool,
    status: 'failed',
    // Same shape `toolExecutor` emits for a failed tool, so the reason surfaces
    // in the answer and trace instead of an unexplained blank failure.
    error: reason,
    result: { status: 'not_computed', ...result },
    evidence: { ...evidence, notes: reason },
    // No measurement was produced, so there is nothing to be confident about.
    confidence: 0,
    metadata: {
      mock: true,
      offline: true,
      available: false,
      notComputed,
      reason,
      timestamp: new Date().toISOString()
    }
  };
}

const OFFLINE_REASON =
  'The ML service was unreachable, so no pixels were read and no measurement was computed. '
  + 'Every scientific value below is null (not computed) — this is not a measurement.';

/**
 * Request facts that are true regardless of whether the ML service answered.
 * Tile identifiers, region and filenames describe the request, not the science,
 * so they are safe to echo and keep `evidence` useful for traceability.
 */
function requestEvidence(payload, extra = {}) {
  const images = [
    ...(Array.isArray(payload?.imageRefs) ? payload.imageRefs : []),
    payload?.tile_id,
    payload?.tile_id_t1,
    payload?.tile_id_t2,
    payload?.optical_tile_id,
    payload?.sar_tile_id
  ].filter(v => v !== undefined && v !== null && v !== '');
  return { images, region: payload?.region || {}, ...extra };
}

/**
 * Build the offline result for an endpoint.
 *
 * Every branch returns `unavailableResult(...)`: the same ToolOutput shape with
 * the real schema's keys present and null. No branch invents a number.
 */
function buildMockResult(endpoint, payload) {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  switch (cleanEndpoint) {
    case '/ground':
      // Grounding is not implemented anywhere in the ML service. Reporting a
      // bounding box here would mean inventing coordinates for a detector that
      // does not exist, so the capability is reported as unavailable instead.
      return unavailableResult({
        tool: 'ground',
        reason:
          'Grounding (feature localization / bounding-box detection) is not implemented. '
          + 'No detector ran, so no bounding box, label, or grounding confidence can be reported.',
        result: {
          boundingBox: null,
          label: payload?.target || null,
          detectedFeatures: null
        },
        evidence: requestEvidence(payload, { target: payload?.target || null }),
        notComputed: ['boundingBox', 'label', 'detectedFeatures', 'confidence']
      });

    case '/optical-sar':
      // The real tool computes per-modality statistics, a fused feature and
      // cross-modal correlation. It computes no land-cover percentages, so a
      // mock must not report any.
      return unavailableResult({
        tool: 'optical_sar',
        reason: `${OFFLINE_REASON} Optical/SAR fusion and cross-modal correlation were not computed.`,
        result: {
          fusedLandCover: null,
          optical: null,
          sar: null,
          fusion: null,
          overlap: null,
          alignment: null,
          crs: null,
          resolution: null,
          summary: null
        },
        evidence: requestEvidence(payload, { optical_filename: null, sar_filename: null }),
        notComputed: [
          'optical', 'sar', 'fusion', 'overlap', 'alignment', 'crs', 'resolution', 'fusedLandCover'
        ]
      });

    case '/ndvi':
      return unavailableResult({
        tool: 'ndvi',
        reason: `${OFFLINE_REASON} NDVI was not computed.`,
        result: {
          index: 'NDVI',
          min: null,
          max: null,
          mean: null,
          median: null,
          valid_pixel_count: null,
          total_pixel_count: null,
          bands: null,
          band_detection_method: null,
          warnings: []
        },
        evidence: requestEvidence(payload, { filename: null, bands_used: null }),
        notComputed: ['min', 'max', 'mean', 'median', 'valid_pixel_count', 'total_pixel_count', 'bands']
      });

    case '/ndwi':
      return unavailableResult({
        tool: 'ndwi',
        reason: `${OFFLINE_REASON} NDWI was not computed.`,
        result: {
          index: 'NDWI',
          min: null,
          max: null,
          mean: null,
          median: null,
          valid_pixel_count: null,
          total_pixel_count: null,
          bands: null,
          band_detection_method: null,
          warnings: []
        },
        evidence: requestEvidence(payload, { filename: null, bands_used: null }),
        notComputed: ['min', 'max', 'mean', 'median', 'valid_pixel_count', 'total_pixel_count', 'bands']
      });

    case '/area':
      return unavailableResult({
        tool: 'area',
        reason: `${OFFLINE_REASON} No area was measured.`,
        result: {
          status: 'not_computed',
          area_km2: null,
          area_ha: null,
          area_m2: null,
          valid_pixel_count: null,
          total_pixel_count: null,
          resolution_m: null,
          resolution_y_m: null,
          crs: null,
          feature_type: payload?.featureType || null,
          pixel_area_m2: null,
          warnings: [],
          confidence: 0
        },
        evidence: requestEvidence(payload, { filename: null }),
        notComputed: ['area_km2', 'area_ha', 'area_m2', 'valid_pixel_count', 'total_pixel_count', 'crs', 'pixel_area_m2']
      });

    case '/change':
      return unavailableResult({
        tool: 'change',
        reason: `${OFFLINE_REASON} Change detection was not computed.`,
        result: {
          method: 'absolute_difference',
          comparison_band: null,
          threshold: null,
          threshold_source: null,
          total_pixels: null,
          valid_pixels: null,
          invalid_pixels: null,
          changed_pixels: null,
          unchanged_pixels: null,
          change_percentage: null,
          mean_difference: null,
          max_difference: null,
          changed_area_km2: null,
          aligned: null,
          alignment: null,
          warnings: []
        },
        evidence: requestEvidence(payload, { image1: null, image2: null, method: 'absolute_difference' }),
        notComputed: [
          'change_percentage', 'mean_difference', 'max_difference', 'changed_area_km2',
          'changed_pixels', 'unchanged_pixels', 'threshold', 'aligned', 'alignment'
        ]
      });

    case '/trend':
      return unavailableResult({
        tool: 'trend',
        reason: `${OFFLINE_REASON} No time series was retrieved or analysed.`,
        result: {
          metric: payload?.metric || null,
          region: payload?.region || null,
          date_range: { start: payload?.start_date || null, end: payload?.end_date || null },
          interval: payload?.interval || null,
          source: null,
          collection: null,
          band_mapping: null,
          quality_mask: null,
          series: [],
          trend: null,
          warnings: []
        },
        evidence: requestEvidence(payload),
        notComputed: ['series', 'trend', 'source', 'collection', 'band_mapping', 'quality_mask']
      });

    case '/vqa':
      // Mirrors the ML service's own offline placeholder: a literal marker
      // string rather than a fabricated observation of the image.
      return unavailableResult({
        tool: 'vqa',
        reason: `${OFFLINE_REASON} No visual question answering was performed.`,
        result: {
          answer: 'offline-placeholder',
          question: payload?.question || null,
          answer_mode: null,
          confidence: 0
        },
        evidence: requestEvidence(payload, { question: payload?.question || null, image: { filename: null } }),
        notComputed: ['answer', 'answer_mode', 'confidence']
      });

    case '/caption':
      return unavailableResult({
        tool: 'caption',
        reason: `${OFFLINE_REASON} No caption was generated.`,
        result: { caption: 'offline-placeholder', confidence: 0 },
        evidence: requestEvidence(payload, { image: { filename: null } }),
        notComputed: ['caption', 'keywords', 'confidence']
      });

    case '/validate':
      // Cannot assert a file is valid without opening it.
      return unavailableResult({
        tool: 'validate',
        reason:
          'The ML service was unreachable, so the file was never opened. '
          + 'It cannot be reported as valid or invalid.',
        result: {
          valid: null,
          validation_status: 'not_computed',
          modality: null,
          format: payload?.format || null,
          width: null,
          height: null,
          band_count: null,
          bands: [],
          crs: null,
          bounds: null,
          wgs84_bounds: null,
          resolution: null,
          nodata: null,
          dtype: null,
          warnings: [],
          errors: []
        },
        evidence: requestEvidence(payload, { filename: payload?.filename || null }),
        notComputed: ['valid', 'validation_status', 'modality', 'width', 'height', 'band_count', 'bands', 'crs', 'bounds']
      });

    case '/fetch-imagery':
      // Nothing was downloaded, so there is no imagery to describe. Satellite,
      // band list, capture date and date gap were all invented before.
      return unavailableResult({
        tool: 'fetch-imagery',
        reason:
          'The ML service was unreachable, so no satellite imagery was acquired. '
          + 'No images, dates, bands or resolutions can be reported.',
        result: {
          source: null,
          bounding_box: payload?.bounding_box || null,
          date_range: { start: payload?.start_date || null, end: payload?.end_date || null },
          images: [],
          date_gap_days: null,
          warnings: ['No imagery was acquired: the ML service was unreachable.']
        },
        evidence: { region: payload?.bounding_box || {}, data_source: null },
        notComputed: ['images', 'source', 'date_gap_days', 'date_range']
      });

    case '/stac/search':
      // A scene search needs the live catalog. Reporting fabricated scene ids
      // or counts here would invent satellite observations, so the result is
      // explicitly empty with the reason surfaced.
      return unavailableResult({
        tool: 'stac-search',
        reason:
          'The ML service was unreachable, so no STAC catalog query ran. '
          + 'No scenes, collections or counts can be reported.',
        result: {
          source: null,
          provider: null,
          collection: payload?.collection || (payload?.sensor ? `from-${payload.sensor}` : null),
          collectionName: null,
          resolution: null,
          query: {
            sensor: payload?.sensor || null,
            collection: payload?.collection || null,
            aoi: payload?.aoi || null,
            aoiCrs: payload?.aoiCrs || 'EPSG:4326',
            dateRange: payload?.dateRange || { start: null, end: null },
            cloudMax: payload?.cloudMax ?? null,
            limit: payload?.limit ?? null
          },
          scenes: [],
          count: 0,
          warnings: ['No scenes were searched: the ML service was unreachable.']
        },
        evidence: { region: payload?.aoi || {}, data_source: null },
        notComputed: ['scenes', 'count', 'collectionName', 'collection', 'resolution']
      });

    case '/stac/ingest':
      // Nothing was acquired, so there is no analysis raster, preview, scene
      // metadata or dedupe key to report. Any of those would be fabricated.
      return unavailableResult({
        tool: 'stac-ingest',
        reason:
          'The ML service was unreachable, so no scene was acquired. '
          + 'No raster, preview, scene metadata or dedupe key can be reported.',
        result: {
          source: null,
          provider: null,
          collection: payload?.collection || null,
          collectionName: null,
          sceneId: payload?.sceneId || null,
          scene: null,
          aoi: payload?.aoi ? { geometry: payload.aoi, crs: payload?.aoiCrs || null } : null,
          analysisRaster: null,
          analysis: null,
          preview: null,
          validation: null,
          dedupeKey: null,
          warnings: ['No scene was acquired: the ML service was unreachable.']
        },
        evidence: { region: payload?.aoi || {}, data_source: null },
        notComputed: ['analysisRaster', 'analysis', 'preview', 'validation', 'dedupeKey', 'scene']
      });

    default:
      return unavailableResult({
        tool: cleanEndpoint.replace('/', ''),
        reason: `${OFFLINE_REASON} This endpoint has no offline result definition.`,
        result: {},
        evidence: requestEvidence(payload),
        notComputed: ['*']
      });
  }
}

/**
 * Attach the honest AOI report to a mock result, in both the result body and
 * the metadata, mirroring the real ML service's contract.
 */
function withMockAoi(mock, payload) {
  const aoi = mockAoiReport(payload);
  return {
    ...mock,
    result: { ...(mock.result || {}), aoi },
    metadata: { ...(mock.metadata || {}), aoi }
  };
}

/**
 * Returns mock result for a given endpoint when ML service is offline/mocked.
 */
function getMockResult(endpoint, payload) {
  return withMockAoi(buildMockResult(endpoint, payload), payload);
}

/**
 * Call ML service endpoint with payload, falling back to mock response if unavailable.
 */
export async function callMlService(endpoint, payload, options = {}) {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  // Never attempt a call the ML service does not implement. The honest result
  // is returned directly so the reason is "not implemented" rather than an
  // indistinguishable 404-then-offline-fallback.
  if (UNIMPLEMENTED_ENDPOINTS.has(cleanEndpoint)) {
    return getMockResult(cleanEndpoint, payload);
  }

  const timeoutMs = options.timeout || DEFAULT_TIMEOUT;
  const url = `${ML_SERVICE_BASE_URL}${cleanEndpoint}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  activeMlCalls += 1;

  try {
    const isFile = isFileEndpoint(endpoint);
    let response;
    if (isFile) {
      // Geo/RS file endpoints require multipart/form-data with actual file bytes.
      response = await sendMultipart(url, endpoint, payload, options, controller.signal);
    } else {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    }

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[MLServiceClient] Call to ${url} failed with HTTP ${response.status}: ${errText}. Falling back to mock.`);
      return getMockResult(endpoint, payload);
    }

    const data = await response.json();
    return data;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[MLServiceClient] Unable to connect to ML service at ${url} (${err.message}). Using mock result.`);
    return getMockResult(endpoint, payload);
  } finally {
    activeMlCalls = Math.max(0, activeMlCalls - 1);
  }
}

// Number of ML-service calls currently in flight. Used to keep a warmup from
// contending with a live query: the VLM is single-model and concurrent warmup +
// inference caused hangs in the past.
let activeMlCalls = 0;
let warmupPromise = null;

/**
 * Warm up the ML service VLM (load base model + LoRA adapter into its
 * in-memory cache) so the first user query does not pay the cold-start cost.
 *
 * Safe: idempotent on the ML side (cached model), serialized here, and skipped
 * while any other ML call is in flight. Never falls back to mock — the caller
 * only learns whether the warmup actually happened.
 */
export async function warmupMl() {
  if (warmupPromise) return warmupPromise;
  if (activeMlCalls > 0) {
    return { status: 'skipped', reason: 'busy', activeCalls: activeMlCalls };
  }

  warmupPromise = (async () => {
    const controller = new AbortController();
    const timeoutMs = Math.min(DEFAULT_TIMEOUT, 180000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    activeMlCalls += 1;
    try {
      const url = `${ML_SERVICE_BASE_URL}/vlm/warmup`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { status: 'unavailable', httpStatus: response.status, detail };
      }
      const data = await response.json();
      return { status: 'ok', ...data };
    } catch (err) {
      return { status: 'unavailable', reason: err.message };
    } finally {
      activeMlCalls = Math.max(0, activeMlCalls - 1);
    }
  })().finally(() => {
    warmupPromise = null;
  });

  return warmupPromise;
}

export default {
  callMlService,
  warmupMl
};
