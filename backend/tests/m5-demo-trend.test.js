import { jest } from '@jest/globals';

const mockCallMlService = jest.fn();

jest.unstable_mockModule('../src/services/mlServiceClient.js', () => ({
  default: { callMlService: mockCallMlService }
}));

const { MongoMemoryServer } = await import('mongodb-memory-server');
const mongoose = (await import('mongoose')).default;
const request = (await import('supertest')).default;
const { default: app } = await import('../src/index.js');
const { seedTools } = await import('../src/services/seedTools.js');
const { default: ResultsCache } = await import('../src/models/ResultsCache.js');
const { default: Tile } = await import('../src/models/Tile.js');
const { default: Query } = await import('../src/models/Query.js');
const { precomputeDemoTrend } = await import('../src/services/demoTrendService.js');

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seedTools();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const DEMO_ENV_KEYS = [
  'DEMO_TREND_REGION',
  'DEMO_TREND_START_DATE',
  'DEMO_TREND_END_DATE',
  'DEMO_TREND_METRIC',
  'DEMO_TREND_INTERVAL',
  'DEMO_TREND_TTL_DAYS'
];

beforeEach(async () => {
  jest.clearAllMocks();
  process.env.LLM_API_KEY = 'mock-llm-key';
  await ResultsCache.deleteMany({});
  await Tile.deleteMany({});
  await Query.deleteMany({});
});

afterEach(async () => {
  for (const key of DEMO_ENV_KEYS) {
    delete process.env[key];
  }
});

// The chosen demo region is a REQUIRED configuration input; these tests set it
// purely to exercise the mechanism. The repository itself defines no demo region.
const DEMO_REGION = {
  type: 'Polygon',
  coordinates: [[[78.0, 28.0], [78.5, 28.0], [78.5, 28.5], [78.0, 28.5], [78.0, 28.0]]]
};

const OTHER_REGION = {
  type: 'Polygon',
  coordinates: [[[10.0, 10.0], [11.0, 10.0], [11.0, 11.0], [10.0, 11.0], [10.0, 10.0]]]
};

function configureDemoRegion(overrides = {}) {
  process.env.DEMO_TREND_REGION = JSON.stringify(DEMO_REGION);
  process.env.DEMO_TREND_START_DATE = overrides.startDate || '2025-01-01';
  process.env.DEMO_TREND_END_DATE = overrides.endDate || '2025-12-31';
  process.env.DEMO_TREND_METRIC = overrides.metric || 'ndvi';
  process.env.DEMO_TREND_INTERVAL = overrides.interval || 'monthly';
  process.env.DEMO_TREND_TTL_DAYS = String(overrides.ttlDays ?? 365);
}

function regionKey(region) {
  return JSON.stringify({ type: region.type, coordinates: region.coordinates });
}

const PRECOMPUTED_SERIES = [
  { date: '2025-06-01', value: 0.42 },
  { date: '2025-09-01', value: 0.61 }
];

const SUCCESS_RESULT = {
  tool: 'trend',
  status: 'success',
  result: {
    metric: 'ndvi',
    series: [
      { date: '2026-01-01', value: 0.5 },
      { date: '2026-04-01', value: 0.6 }
    ],
    trendSlope: 0.05,
    summary: 'Upward vegetation trend'
  },
  evidence: { region: OTHER_REGION, notes: '' },
  confidence: 0.87,
  metadata: { data_source: 'GEE:Sentinel-2' }
};

const MOCK_RESULT = {
  ...SUCCESS_RESULT,
  metadata: { mock: true, data_source: 'mock', source_warning: 'Not real GEE' }
};

const FAILED_RESULT = {
  tool: 'trend',
  status: 'failed',
  result: { error: 'GEE credentials are not configured' },
  evidence: {},
  confidence: 0,
  metadata: {}
};

async function seedDemoEntry({ useMockMetadata = false } = {}) {
  return ResultsCache.create({
    tool: 'trend',
    metric: 'ndvi',
    region: DEMO_REGION,
    regionKey: regionKey(DEMO_REGION),
    dateRange: { start: new Date('2025-01-01'), end: new Date('2025-12-31') },
    series: PRECOMPUTED_SERIES.map(p => ({ date: new Date(p.date), value: p.value })),
    interval: 'monthly',
    parameters: { region: DEMO_REGION, metric: 'ndvi', startDate: '2025-01-01', endDate: '2025-12-31', interval: 'monthly' },
    result: { metric: 'ndvi', series: PRECOMPUTED_SERIES, trendSlope: 0.04, summary: 'Precomputed demo trend' },
    evidence: { region: DEMO_REGION, notes: 'Precomputed demo-region trend' },
    confidence: 0.91,
    metadata: useMockMetadata
      ? { demoPrecomputed: true, mock: true, data_source: 'mock' }
      : { demoPrecomputed: true, data_source: 'demo-precompute' },
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    computedAt: new Date()
  });
}

describe('M5 §15.5 — demo-trend precompute (config-driven)', () => {
  test('precompute stores a real successful ML result, long-lived and labeled demoPrecomputed', async () => {
    configureDemoRegion();
    mockCallMlService.mockResolvedValue(SUCCESS_RESULT);

    const report = await precomputeDemoTrend();

    expect(report.ok).toBe(true);
    expect(report.inserted).toBe(true);
    expect(report.regionKey).toBe(regionKey(DEMO_REGION));

    const entry = await ResultsCache.findOne({ tool: 'trend' });
    expect(entry).toBeTruthy();
    expect(entry.metadata.demoPrecomputed).toBe(true);
    expect(entry.regionKey).toBe(regionKey(DEMO_REGION));
    expect(entry.metric).toBe('ndvi');
    expect(entry.interval).toBe('monthly');
    expect(entry.result.series).toHaveLength(2);
    expect(entry.expiresAt.getTime() - Date.now()).toBeGreaterThan(300 * 24 * 60 * 60 * 1000);
    expect(mockCallMlService).toHaveBeenCalledTimes(1);
    expect(mockCallMlService.mock.calls[0][0]).toBe('/trend');
  });

  test('precompute refuses a labeled mock result and caches nothing', async () => {
    configureDemoRegion();
    mockCallMlService.mockResolvedValue(MOCK_RESULT);

    const report = await precomputeDemoTrend();

    expect(report.ok).toBe(false);
    expect(report.reason).toContain('mock');
    expect(await ResultsCache.countDocuments()).toBe(0);
  });

  test('precompute refuses a failed ML result and caches nothing', async () => {
    configureDemoRegion();
    mockCallMlService.mockResolvedValue(FAILED_RESULT);

    const report = await precomputeDemoTrend();

    expect(report.ok).toBe(false);
    expect(report.reason).toContain('failed');
    expect(await ResultsCache.countDocuments()).toBe(0);
  });

  test('precompute without configuration reports the required inputs, never fabricates a region', async () => {
    mockCallMlService.mockResolvedValue(SUCCESS_RESULT);

    const report = await precomputeDemoTrend();

    expect(report.ok).toBe(false);
    expect(report.reason).toContain('DEMO_TREND_REGION');
    expect(report.reason).toContain('DEMO_TREND_START_DATE');
    expect(await ResultsCache.countDocuments()).toBe(0);
    expect(mockCallMlService).not.toHaveBeenCalled();
  });
});

describe('M5 §15.5 — demo-region fallback via POST /api/query/trend', () => {
  const requestBody = {
    region: DEMO_REGION,
    metric: 'ndvi',
    startDate: '2026-01-01',
    endDate: '2026-04-01',
    interval: 'monthly'
  };

  test('live ML failure + valid precomputed demo entry -> labeled demo fallback, no fresh claim', async () => {
    configureDemoRegion();
    await seedDemoEntry();
    mockCallMlService.mockResolvedValue(FAILED_RESULT);

    const res = await request(app).post('/api/query/trend').send(requestBody);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.cache).toEqual({ hit: true, source: 'demo-precompute', computedAt: expect.any(String) });
    expect(res.body.fallback.source).toBe('demo-precompute');
    expect(res.body.fallback.note).toContain('Live ML /trend failed');
    expect(res.body.result.series).toEqual(PRECOMPUTED_SERIES);
    expect(res.body.evidence.isDemoPrecompute).toBe(true);
    expect(res.body.executionTrace.some(e => e.step === 'trend_demo_fallback')).toBe(true);
    expect(res.body.executionTrace.some(e => e.step === 'trend_ml_failed')).toBe(true);
    expect(await ResultsCache.countDocuments()).toBe(1);
  });

  test('mock-labeled live ML + valid demo entry -> demo fallback, mock never served as real', async () => {
    configureDemoRegion();
    await seedDemoEntry();
    mockCallMlService.mockResolvedValue(MOCK_RESULT);

    const res = await request(app).post('/api/query/trend').send(requestBody);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.cache.source).toBe('demo-precompute');
    expect(res.body.fallback.source).toBe('demo-precompute');
    expect(res.body.result.series).toEqual(PRECOMPUTED_SERIES);
    expect(await ResultsCache.countDocuments()).toBe(1);
  });

  test('different region never uses the demo fallback -> honest failure preserved', async () => {
    configureDemoRegion();
    await seedDemoEntry();
    mockCallMlService.mockResolvedValue(FAILED_RESULT);

    const res = await request(app).post('/api/query/trend').send({
      ...requestBody,
      region: OTHER_REGION
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.fallback).toBeUndefined();
    expect(res.body.cache).toBeUndefined();
    expect(res.body.confidence).toBe(0);
    expect(await ResultsCache.countDocuments()).toBe(1);
  });

  test('no precomputed demo entry + live ML failure -> honest failure, no fallback claim', async () => {
    configureDemoRegion();
    mockCallMlService.mockResolvedValue(FAILED_RESULT);

    const res = await request(app).post('/api/query/trend').send(requestBody);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.fallback).toBeUndefined();
    expect(res.body.cache).toBeUndefined();
    expect(await ResultsCache.countDocuments()).toBe(0);
  });

  test('mock-labeled precomputed cache entry is never treated as a valid demo fallback', async () => {
    configureDemoRegion();
    await seedDemoEntry({ useMockMetadata: true });
    mockCallMlService.mockResolvedValue(FAILED_RESULT);

    const res = await request(app).post('/api/query/trend').send(requestBody);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.fallback).toBeUndefined();
  });

  test('covering demo-precomputed entry is served as a transparent labeled cache hit', async () => {
    configureDemoRegion();
    await ResultsCache.create({
      tool: 'trend',
      metric: 'ndvi',
      region: DEMO_REGION,
      regionKey: regionKey(DEMO_REGION),
      dateRange: { start: new Date('2020-01-01'), end: new Date('2030-12-31') },
      series: PRECOMPUTED_SERIES.map(p => ({ date: new Date(p.date), value: p.value })),
      interval: 'monthly',
      parameters: { region: DEMO_REGION, metric: 'ndvi', startDate: '2020-01-01', endDate: '2030-12-31', interval: 'monthly' },
      result: { metric: 'ndvi', series: PRECOMPUTED_SERIES, summary: 'Precomputed demo trend' },
      evidence: { region: DEMO_REGION, notes: 'Precomputed demo-region trend' },
      confidence: 0.91,
      metadata: { demoPrecomputed: true, data_source: 'demo-precompute' },
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      computedAt: new Date()
    });
    mockCallMlService.mockResolvedValue(SUCCESS_RESULT);

    const res = await request(app).post('/api/query/trend').send(requestBody);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.cache.hit).toBe(true);
    expect(res.body.cache.source).toBe('demo-precompute');
    expect(res.body.result.series).toEqual(PRECOMPUTED_SERIES);
    expect(mockCallMlService).not.toHaveBeenCalled();
  });
});

describe('M5 §15.5a — E2E fetch-by-region -> full /api/query pipeline', () => {
  test('acquire region imagery, then run a normal query against the fetched tile with persistence', async () => {
    const boundingBox = {
      type: 'Polygon',
      coordinates: [[[78.0, 28.0], [78.5, 28.0], [78.5, 28.5], [78.0, 28.5], [78.0, 28.0]]]
    };

    mockCallMlService.mockImplementation((endpoint) => {
      if (endpoint === '/fetch-imagery') {
        return Promise.resolve({
          status: 'success',
          result: {
            images: [
              {
                modality: 'optical',
                filename: 'fetched_demo_optical.tif',
                filePath: '/tmp/fetched_demo_optical.tif',
                format: 'geotiff',
                downloaded: true,
                date: '2026-03-01',
                product_id: 'S2A_10611',
                data_source: 'GEE:Sentinel-2',
                validated: true,
                validation_status: 'valid'
              }
            ],
            date_gap_days: 0
          }
        });
      }
      if (endpoint === '/ndvi') {
        return Promise.resolve({
          status: 'success',
          result: { value: 0.55, map: 'http://localhost:8000/ndvi/map.png' },
          evidence: { notes: 'NDVI computed from fetched optical raster' },
          confidence: 0.9
        });
      }
      return Promise.resolve({ status: 'failed', result: { error: `unexpected endpoint ${endpoint}` } });
    });

    // ---- 1. fetch region imagery (tile persistence) ----
    const fetchRes = await request(app).post('/api/images/fetch-by-region').send({
      boundingBox,
      startDate: '2026-02-01',
      endDate: '2026-04-01'
    });

    expect(fetchRes.status).toBe(200);
    expect(fetchRes.body.status).toBe('success');
    const tileId = fetchRes.body.tileId;
    expect(mongoose.Types.ObjectId.isValid(tileId)).toBe(true);

    const tile = await Tile.findById(tileId);
    expect(tile).toBeTruthy();
    expect(tile.source).toBe('gee-fetch');
    expect(tile.modality).toBe('optical');
    expect(tile.filePath).toBe('/tmp/fetched_demo_optical.tif');

    // ---- 2. full query through the normal agent pipeline ----
    const queryRes = await request(app).post('/api/query').send({
      queryText: 'Calculate the NDVI of the fetched region',
      imageRefs: [tileId]
    });

    expect(queryRes.status).toBe(200);
    expect(['success', 'partial']).toContain(queryRes.body.status);
    expect(queryRes.body.taskType).toBe('NDVI');
    expect(queryRes.body.toolResults[0].tool).toBe('ndvi');
    expect(queryRes.body.toolResults[0].status).toBe('success');
    expect(queryRes.body.result.value).toBe(0.55);
    expect(queryRes.body.confidence).toBeGreaterThan(0);
    expect(queryRes.body.evidence.images).toContain(tileId);

    // ---- 3. query persistence -> history and report ----
    const historyRes = await request(app).get('/api/query/history');
    expect(historyRes.status).toBe(200);
    expect(historyRes.body.some(q => String(q._id) === queryRes.body._id)).toBe(true);

    const reportRes = await request(app).get(`/api/query/${queryRes.body._id}/report`);
    expect(reportRes.status).toBe(200);
    expect(reportRes.body.queryText).toBe('Calculate the NDVI of the fetched region');
    expect(reportRes.body.toolsInvoked).toContain('ndvi');
    expect(reportRes.body.status).toBe(queryRes.body.status);
  });
});