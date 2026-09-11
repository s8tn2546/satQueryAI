/**
 * SatQuery AI — minimal API client for the SatQuery backend.
 *
 * Base URL resolution:
 *   1. VITE_API_BASE_URL env var (see .env.example)
 *   2. Dev fallback: http://localhost:5010
 *
 * Contract-verified against backend/src/routes/query.js and
 * backend/src/routes/images.js. No authentication is implemented because
 * every backend endpoint accepts anonymous access (authMiddleware is
 * optional; no route uses requireAuth).
 */

const DEV_FALLBACK_BASE_URL = 'http://localhost:5010';

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || DEV_FALLBACK_BASE_URL
).replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message, { status = 0, body = null, url = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function backendErrorMessage(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.answerText === 'string') return payload.answerText;
  return null;
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildQueryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

async function request(path, { method = 'GET', headers = {}, body = null, params = {} } = {}) {
  const url = `${API_BASE_URL}${path}${buildQueryString(params)}`;
  const options = { method, headers };

  if (body instanceof FormData) {
    // Let the browser set Content-Type (with boundary) for FormData.
    options.body = body;
  } else if (body !== null) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new ApiError(`Network error reaching ${url}: ${error.message}`, { url });
  }

  const payload = await parseBody(response);

  if (!response.ok) {
    const message =
      backendErrorMessage(payload) || `Request failed with status ${response.status}`;
    throw new ApiError(message, { status: response.status, body: payload, url });
  }

  return payload;
}

export function get(path, params) {
  return request(path, { method: 'GET', params });
}

export function post(path, body) {
  return request(path, { method: 'POST', body });
}

export function postForm(path, formData) {
  return request(path, { method: 'POST', body: formData });
}

// --- Endpoint helpers (contract-verified) ---

/**
 * POST /api/query
 * Pipeline response: { answerText, taskType, plan, toolResults, evidence,
 * confidence, confidenceSignals, executionTrace, status, _id }.
 */
export function submitQuery({ queryText, imageRefs = [], parameters = {}, sessionId } = {}) {
  return post('/api/query', {
    queryText,
    imageRefs,
    parameters,
    ...(sessionId ? { sessionId } : {}),
  });
}

/**
 * GET /api/query/history?sessionId=&limit=
 * Returns an array of Query documents (sorted by createdAt desc).
 */
export function fetchQueryHistory({ sessionId, limit } = {}) {
  return get('/api/query/history', { sessionId, limit });
}

/**
 * POST /api/images/upload (multipart/form-data)
 * Field name: images (up to 5 files). Optional string fields: source,
 * modality (string or array), modality_hint.
 * Returns: { status, tileId, tileIds, tiles, validationResult }.
 */
export function uploadImages(files, { source, modality, modalityHint } = {}) {
  const formData = new FormData();
  for (const file of files) {
    formData.append('images', file);
  }
  if (source) formData.append('source', source);
  if (modality) {
    const list = Array.isArray(modality) ? modality : [modality];
    for (const m of list) formData.append('modality', m);
  }
  if (modalityHint) formData.append('modality_hint', modalityHint);
  return postForm('/api/images/upload', formData);
}

/**
 * POST /api/images/fetch-by-region
 * Region-based imagery acquisition (Sentinel-2 optical + Sentinel-1 SAR).
 * Bbox: { west, south, east, north }. Accepted option: dateRange
 * ({ start, end } ISO strings or [start, end]).
 * Returns the same shape as POST /api/images/upload: { status, tileId, tileIds, tiles }.
 */
// eslint-disable-next-line no-unused-vars -- destructured caller option kept for symmetry
export function fetchRegionImagery(bbox, { mode = 'single', dateRange = null } = {}) {
  const polygon = {
    type: 'Polygon',
    coordinates: [[
      [bbox.west, bbox.south],
      [bbox.east, bbox.south],
      [bbox.east, bbox.north],
      [bbox.west, bbox.north],
      [bbox.west, bbox.south],
    ]],
  };
  const startDate = (dateRange && (dateRange.start || dateRange[0])) || undefined;
  const endDate = (dateRange && (dateRange.end || dateRange[1])) || undefined;
  return post('/api/images/fetch-by-region', { boundingBox: polygon, startDate, endDate });
}

/**
 * POST /api/ml/warmup
 * Best-effort pre-load of the VLM (base + LoRA) on the ML service. Safe and
 * idempotent; the backend skips it while a query is in flight. Fire-and-forget
 * at app entry so the first real query does not pay cold-start inference cost.
 */
export function warmupVlm() {
  return post('/api/ml/warmup', {});
}

/**
 * GET /api/tiles/:id
 * Tile metadata for the Evidence view: { _id, source, modality, format,
 * renderable, storedFile, captureDate, crs, resolution, bands }.
 */
export function fetchTile(id) {
  return get(`/api/tiles/${id}`);
}

/**
 * URL of a persisted tile's source imagery. Renderable formats (PNG/JPEG)
 * resolve to an <img> src; TIFF/unsupported formats are rendered as labelled
 * cards instead (the endpoint rejects them with 415).
 */
export function tileImageUrl(id) {
  return `${API_BASE_URL}/api/tiles/${id}/image`;
}