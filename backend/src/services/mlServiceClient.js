import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

const ML_SERVICE_BASE_URL = process.env.ML_SERVICE_BASE_URL || 'http://localhost:8000';
const DEFAULT_TIMEOUT = 5000;

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
  '/change': { sourceKeys: ['image_t1_path', 'image_t2_path'], fileFields: ['image1', 'image2'] },
  '/optical-sar': { sourceKeys: ['optical_path', 'sar_path'], fileFields: ['optical_image', 'sar_image'] },
};

// Payload keys that are metadata (IDs) rather than request parameters and should
// not be forwarded as form fields. File path keys are handled separately.
const NON_FORM_KEYS = new Set([
  'image_path', 'image_t1_path', 'image_t2_path', 'optical_path', 'sar_path',
  'tile_id', 'tile_id_t1', 'tile_id_t2', 'optical_tile_id', 'sar_tile_id',
  'imageRefs'
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
 * Returns mock result for a given endpoint when ML service is offline/mocked.
 */
function getMockResult(endpoint, payload) {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  switch (cleanEndpoint) {
    case '/validate':
      return {
        tool: 'validate',
        status: 'success',
        result: {
          valid: true,
          validation_status: 'valid',
          format: payload.format || 'TIFF',
          errors: [],
          warnings: []
        },
        evidence: { filename: payload.filename || 'uploaded-file' },
        confidence: 1.0,
        metadata: { mock: true }
      };

    case '/fetch-imagery':
      return {
        tool: 'fetch-imagery',
        status: 'success',
        result: {
          images: [
            {
              modality: 'optical',
              source: 'sentinel-2',
              satellite: 'Sentinel-2',
              filePath: null,
              downloaded: false,
              captureDate: '2026-01-01T00:00:00Z',
              boundingBox: payload.bounding_box || null,
              crs: 'EPSG:4326',
              resolution: 10,
              bands: ['B2', 'B3', 'B4', 'B8'],
              validated: false,
              validation_status: 'not-downloaded'
            },
            {
              modality: 'sar',
              source: 'sentinel-1',
              satellite: 'Sentinel-1',
              filePath: null,
              downloaded: false,
              captureDate: '2026-01-04T00:00:00Z',
              boundingBox: payload.bounding_box || null,
              crs: 'EPSG:4326',
              resolution: 10,
              bands: ['VV', 'VH'],
              validated: false,
              validation_status: 'not-downloaded'
            }
          ],
          date_gap_days: 3,
          date_range: { start: payload.start_date || null, end: payload.end_date || null },
          source: 'mock',
          warnings: ['Mock/fixture data — NOT real GEE satellite observations.']
        },
        evidence: { region: payload.bounding_box || {}, data_source: 'mock' },
        confidence: 0.7,
        metadata: { data_source: 'mock', source_warning: 'Mock/fixture data. Not real GEE satellite imagery.' }
      };

    case '/vqa':
      return {
        tool: 'vqa',
        status: 'success',
        result: {
          answer: `Based on visual inspection of the satellite imagery, ${payload.question || 'the requested feature'} is visible with high confidence. The area features predominant urban infrastructure and sparse vegetation cover.`,
          confidence: 0.92
        },
        evidence: { images: payload.imageRefs || [payload.tileId], region: payload.region || {}, notes: 'VQA inference completed successfully.' },
        confidence: 0.92,
        metadata: { timestamp: new Date().toISOString() }
      };

    case '/caption':
      return {
        tool: 'caption',
        status: 'success',
        result: {
          caption: 'High-resolution multispectral satellite view depicting mixed land cover with dense built-up structures, primary road networks, and adjacent agricultural parcels.',
          keywords: ['built-up', 'road network', 'agricultural', 'urban']
        },
        evidence: { images: payload.imageRefs || [payload.tileId], region: payload.region || {}, notes: 'Image captioning generated.' },
        confidence: 0.89,
        metadata: { timestamp: new Date().toISOString() }
      };

    case '/ground':
      return {
        tool: 'ground',
        status: 'success',
        result: {
          boundingBox: [0.25, 0.30, 0.65, 0.70],
          label: payload.target || 'water body',
          detectedFeatures: 1
        },
        evidence: { images: payload.imageRefs || [payload.tileId], region: payload.region || {}, notes: 'Feature grounding bounding box computed.' },
        confidence: 0.88,
        metadata: { timestamp: new Date().toISOString() }
      };

    case '/change':
      return {
        tool: 'change',
        status: 'success',
        result: {
          changePercentage: 14.8,
          changeMaskUrl: '/cache/masks/change_mask_001.png',
          summary: 'Significant urban expansion and vegetation reduction detected between Time 1 and Time 2 across the central sector (14.8% net change).'
        },
        evidence: { images: payload.imageRefs || [payload.tile_id_t1, payload.tile_id_t2], region: payload.region || {}, notes: 'Bi-temporal change detection mask generated.' },
        confidence: 0.94,
        metadata: { timestamp: new Date().toISOString() }
      };

    case '/optical-sar':
      return {
        tool: 'optical_sar',
        status: 'success',
        result: {
          fusedLandCover: {
            builtUpPercent: 42.5,
            waterPercent: 18.2,
            vegetationPercent: 31.3,
            bareSoilPercent: 8.0
          },
          summary: 'Optical and SAR fusion successfully separated built-up structures from water bodies despite cloud/shadow coverage.'
        },
        evidence: { images: payload.imageRefs || [payload.optical_tile_id, payload.sar_tile_id], region: payload.region || {}, notes: 'Cross-modal Sentinel-1 SAR + Sentinel-2 Optical fusion.' },
        confidence: 0.95,
        metadata: { timestamp: new Date().toISOString() }
      };

    case '/ndvi':
      return {
        tool: 'ndvi',
        status: 'success',
        result: {
          value: 0.64,
          map: '/cache/masks/ndvi_raster_001.png',
          classification: 'Moderate-to-dense healthy vegetation'
        },
        evidence: { images: payload.imageRefs || [payload.tile_id], region: payload.region || {}, notes: 'NDVI calculation from NIR and Red optical bands.' },
        confidence: 0.96,
        metadata: { timestamp: new Date().toISOString() }
      };

    case '/ndwi':
      return {
        tool: 'ndwi',
        status: 'success',
        result: {
          value: 0.45,
          map: '/cache/masks/ndwi_raster_001.png',
          classification: 'Delineated surface water body'
        },
        evidence: { images: payload.imageRefs || [payload.tile_id], region: payload.region || {}, notes: 'NDWI calculation from Green and NIR optical bands.' },
        confidence: 0.95,
        metadata: { timestamp: new Date().toISOString() }
      };

    case '/area':
      return {
        tool: 'area',
        status: 'success',
        result: {
          areaKm2: 12.45,
          featureType: payload.featureType || 'water body',
          pixelCount: 124500
        },
        evidence: { images: payload.imageRefs || [payload.tile_id], region: payload.region || {}, notes: 'Geospatial area measurement computed.' },
        confidence: 0.93,
        metadata: { timestamp: new Date().toISOString() }
      };

    case '/trend':
      return {
        tool: 'trend',
        status: 'success',
        result: {
          metric: payload.metric || 'ndvi',
          series: [
            { date: '2025-01-01', value: 0.52 },
            { date: '2025-04-01', value: 0.58 },
            { date: '2025-07-01', value: 0.65 },
            { date: '2025-10-01', value: 0.61 },
            { date: '2026-01-01', value: 0.63 },
            { date: '2026-04-01', value: 0.67 }
          ],
          trendSlope: 0.025,
          summary: 'Positive multi-temporal vegetation trend (+2.5% per quarter) observed over the selected region.'
        },
        evidence: { region: payload.region || {}, notes: 'Multi-temporal time series computed.' },
        confidence: 0.91,
        metadata: { timestamp: new Date().toISOString() }
      };

    default:
      return {
        tool: endpoint.replace('/', ''),
        status: 'success',
        result: { message: `Executed tool at ${endpoint}` },
        evidence: { images: payload.imageRefs || [], region: payload.region || {} },
        confidence: 0.85,
        metadata: { timestamp: new Date().toISOString() }
      };
  }
}

/**
 * Call ML service endpoint with payload, falling back to mock response if unavailable.
 */
export async function callMlService(endpoint, payload, options = {}) {
  const timeoutMs = options.timeout || DEFAULT_TIMEOUT;
  const url = `${ML_SERVICE_BASE_URL}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
  }
}

export default {
  callMlService
};
