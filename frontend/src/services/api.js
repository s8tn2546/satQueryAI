/**
 * SatQuery AI — minimal API client for the SatQuery backend.
 *
 * Base URL resolution:
 *   1. VITE_API_BASE_URL env var (see .env.example)
 *   2. Dev fallback: http://localhost:5000
 *
 * Contract-verified against backend/src/routes/query.js and
 * backend/src/routes/images.js. No authentication is implemented because
 * every backend endpoint accepts anonymous access (authMiddleware is
 * optional; no route uses requireAuth).
 */

const DEV_FALLBACK_BASE_URL = 'http://localhost:5000';

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