import { jest } from '@jest/globals';

const { default: mlServiceClient } = await import('../src/services/mlServiceClient.js');

let originalFetch;

beforeAll(() => {
  originalFetch = global.fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

const POLYGON = {
  type: 'Polygon',
  coordinates: [[[72.0, 18.0], [72.5, 18.0], [72.5, 18.5], [72.0, 18.5], [72.0, 18.0]]]
};

const ENDPOINTS = [
  '/ground', '/optical-sar', '/ndvi', '/ndwi', '/area',
  '/change', '/trend', '/vqa', '/caption', '/validate', '/fetch-imagery'
];

/** Payload exercising every request-echo field a fallback may legitimately repeat. */
const RICH_PAYLOAD = {
  tile_id: 't-main',
  tile_id_t1: 't-1',
  tile_id_t2: 't-2',
  optical_tile_id: 'o-1',
  sar_tile_id: 's-1',
  imageRefs: ['r-1', 'r-2'],
  target: 'lake',
  question: 'Is there open water?',
  metric: 'ndvi',
  featureType: 'water body',
  interval: 'monthly',
  start_date: '2025-01-01',
  end_date: '2025-12-31',
  filename: 'input.tif',
  format: 'tiff',
  region: POLYGON,
  aoi_geometry: POLYGON
};

function fetchStub() {
  return jest.fn(async () => ({ ok: false, status: 503, text: async () => 'offline' }));
}

async function fallbackFor(endpoint, payload = RICH_PAYLOAD) {
  global.fetch = fetchStub();
  return mlServiceClient.callMlService(endpoint, payload);
}

/** Collect every finite numeric leaf reachable from `value`, with its key path. */
function numericLeaves(value, path = '', out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => numericLeaves(v, `${path}[${i}]`, out));
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      numericLeaves(v, path ? `${path}.${k}` : k, out);
    }
    return out;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push({ key: path.split('.').pop(), path, value });
  }
  return out;
}

// Any key whose name implies a measurement, ratio, count or score.
const MEASUREMENT_KEY = /mean|median|percent|value|area|pixel|slope|confidence|score|count|ratio|correlation|std|deviation|gap|resolution|feature|bounding|box|index_value|crs_scale/i;

describe('Offline fallbacks never fabricate scientific values', () => {
  it.each(ENDPOINTS)('%s reports a real-compatible schema with no invented numbers', async (endpoint) => {
    const r = await fallbackFor(endpoint);

    // Nothing was computed, so nothing may be reported as computed.
    expect(r.status).toBe('failed');
    expect(r.result.status).toBe('not_computed');
    expect(r.confidence).toBe(0);

    // Every numeric leaf must be a zero-confidence sentinel, never a measurement.
    const leaves = numericLeaves(r.result);
    const fabricated = leaves.filter(l => {
      if (l.key === 'confidence') return l.value !== 0;
      return MEASUREMENT_KEY.test(l.key) ? true : false;
    });
    expect(fabricated).toEqual([]);
  });

  it.each(ENDPOINTS)('%s flags itself as offline and unavailable', async (endpoint) => {
    const r = await fallbackFor(endpoint);
    expect(r.metadata.mock).toBe(true);
    expect(r.metadata.offline).toBe(true);
    expect(r.metadata.available).toBe(false);
    expect(typeof r.metadata.reason).toBe('string');
    expect(r.metadata.reason.length).toBeGreaterThan(0);
    expect(Array.isArray(r.metadata.notComputed)).toBe(true);
    expect(r.metadata.notComputed.length).toBeGreaterThan(0);
  });

  it.each(ENDPOINTS)('%s explains the failure in the evidence notes', async (endpoint) => {
    const r = await fallbackFor(endpoint);
    expect(r.evidence.notes).toBe(r.metadata.reason);
  });
});

describe('Real schema parity: every real result key exists in the fallback', () => {
  const REQUIRED_KEYS = {
    '/ndvi': ['min', 'max', 'mean', 'median', 'valid_pixel_count', 'total_pixel_count', 'bands'],
    '/ndwi': ['min', 'max', 'mean', 'median', 'valid_pixel_count', 'total_pixel_count', 'bands'],
    '/area': ['area_km2', 'area_ha', 'area_m2', 'valid_pixel_count', 'total_pixel_count', 'crs', 'feature_type', 'pixel_area_m2'],
    '/change': ['change_percentage', 'mean_difference', 'max_difference', 'changed_area_km2', 'changed_pixels', 'unchanged_pixels', 'threshold', 'aligned'],
    '/trend': ['series', 'trend', 'metric', 'interval'],
    '/vqa': ['answer', 'question', 'confidence'],
    '/caption': ['caption', 'confidence'],
    '/validate': ['valid', 'validation_status', 'modality', 'width', 'height', 'band_count', 'bands', 'crs'],
    '/optical-sar': ['optical', 'sar', 'fusion', 'overlap', 'alignment', 'crs', 'resolution'],
    '/ground': ['boundingBox', 'label', 'detectedFeatures'],
    '/fetch-imagery': ['images', 'source', 'date_gap_days']
  };

  // Keys that legitimately echo the request rather than a measurement.
  const REQUEST_ECHOES = new Set(['metric', 'interval', 'question', 'feature_type', 'label', 'index']);
  // `confidence` is asserted separately: 0 is the honest sentinel, not a null.
  const NON_MEASUREMENT = new Set([...REQUEST_ECHOES, 'confidence']);

  it.each(Object.entries(REQUIRED_KEYS))('%s exposes %j as null when not computed', async (endpoint, keys) => {
    const r = await fallbackFor(endpoint);
    for (const key of keys) {
      expect(Object.prototype.hasOwnProperty.call(r.result, key)).toBe(true);
    }
    for (const key of keys.filter(k => MEASUREMENT_KEY.test(k) && !NON_MEASUREMENT.has(k))) {
      expect(r.result[key]).toBeNull();
    }
    if (keys.includes('confidence')) {
      expect(r.result.confidence).toBe(0);
    }
  });
});

describe('/ground is reported as unimplemented, never as a detected feature', () => {
  it('does not attempt a network call', async () => {
    const f = fetchStub();
    global.fetch = f;
    await mlServiceClient.callMlService('/ground', RICH_PAYLOAD);
    expect(f).not.toHaveBeenCalled();
  });

  it('returns no bounding box, no feature count and no label claim', async () => {
    const r = await fallbackFor('/ground');
    expect(r.status).toBe('failed');
    expect(r.result.boundingBox).toBeNull();
    expect(r.result.detectedFeatures).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.metadata.reason).toMatch(/not implemented/i);
  });
});

describe('/optical-sar reports fusion as not computed, never as land cover', () => {
  it('returns no land-cover percentages and no nested statistics', async () => {
    const r = await fallbackFor('/optical-sar');
    expect(r.status).toBe('failed');
    expect(r.result.fusedLandCover).toBeNull();
    for (const key of ['optical', 'sar', 'fusion', 'overlap', 'alignment', 'crs', 'resolution']) {
      expect(r.result[key]).toBeNull();
    }
    // No nested statistics at all: every fusion block is null, so there is
    // nothing numeric to read.
    expect(numericLeaves(r.result)).toEqual([]);
  });

  it('uses the backend tool name the frontend keys on', async () => {
    const r = await fallbackFor('/optical-sar');
    expect(r.tool).toBe('optical_sar');
  });
});

describe('Real ML responses keep the backend tool name', () => {
  it('renames a hyphenated ML tool name to the canonical snake_case name', async () => {
    const { executeTools } = await import('../src/agents/toolExecutor.js');
    // The real service labels this endpoint "optical-sar"; the backend and
    // frontend key on "optical_sar". A real result must not be dropped.
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tool: 'optical-sar',
        status: 'success',
        result: {
          optical: { normalized_mean: 0.41 },
          sar: { normalized_mean: 0.12 },
          fusion: { method: 'equal_weight_feature_fusion', pearson_correlation: 0.33 }
        },
        evidence: { images: ['o-1', 's-1'] },
        confidence: 0.71,
        metadata: { mock: false }
      })
    }));

    const tools = [{
      name: 'optical_sar',
      description: 'fusion',
      requiredInputs: ['optical_image', 'sar_image'],
      acceptedModalities: ['optical', 'sar'],
      parameters: {},
      endpoint: '/optical-sar',
      outputSchema: {}
    }];
    const tiles = [
      { _id: 'o-1', modality: 'optical', filePath: '/tmp/o.tif' },
      { _id: 's-1', modality: 'sar', filePath: '/tmp/s.tif' }
    ];

    const results = await executeTools(tools, tiles, {});
    expect(results).toHaveLength(1);
    expect(results[0].tool).toBe('optical_sar');
    expect(results[0].status).toBe('success');
    expect(results[0].result.fusion.pearson_correlation).toBe(0.33);
  });
});

describe('VQA and caption fallbacks never describe an unread image', () => {
  it.each([
    ['/vqa', 'answer'],
    ['/caption', 'caption']
  ])('%s returns the explicit offline placeholder', async (endpoint, key) => {
    const r = await fallbackFor(endpoint);
    expect(r.result[key]).toBe('offline-placeholder');
    expect(r.result.confidence).toBe(0);
    expect(r.result[key]).not.toMatch(/satellite|urban|vegetation|built-up|water/i);
  });
});

describe('Validation cannot pass without opening the file', () => {
  it('never claims the file is valid', async () => {
    const r = await fallbackFor('/validate');
    expect(r.status).toBe('failed');
    expect(r.result.valid).toBeNull();
    expect(r.result.validation_status).toBe('not_computed');
    expect(r.confidence).toBe(0);
  });
});

describe('Fetch-imagery never invents acquired scenes', () => {
  it('returns no images, satellite, bands or date gap', async () => {
    const r = await fallbackFor('/fetch-imagery');
    expect(r.status).toBe('failed');
    expect(r.result.images).toEqual([]);
    expect(r.result.date_gap_days).toBeNull();
    expect(r.result.source).toBeNull();
    expect(numericLeaves(r.result)).toEqual([]);
  });
});

describe('The composer never turns an unavailable result into a claim', () => {
  it('does not label the offline placeholder as a measurement', async () => {
    const { composeAnswer } = await import('../src/agents/answerComposer.js');
    const vqa = await fallbackFor('/vqa');
    const ndvi = await fallbackFor('/ndvi');

    const vqaAnswer = await composeAnswer('Is there open water in this scene?', 'VQA', [vqa], []);
    expect(vqaAnswer).not.toMatch(/Measured answer/i);
    expect(vqaAnswer).not.toContain('offline-placeholder');

    // No fabricated index may survive into the narrative.
    const indexAnswer = await composeAnswer('calculate NDVI', 'multi-index-analysis', [ndvi], []);
    expect(indexAnswer).not.toMatch(/0\.64|NDVI value/i);
    expect(indexAnswer).not.toContain('offline-placeholder');
  });
});

describe('AOI honesty is preserved on every fallback', () => {
  it.each(ENDPOINTS)('%s never claims an AOI was applied', async (endpoint) => {
    const r = await fallbackFor(endpoint);
    expect(r.result.aoi.aoiPresent).toBe(true);
    expect(r.result.aoi.aoiApplied).toBe(false);
    expect(r.metadata.aoi).toEqual(r.result.aoi);
  });
});
