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

beforeEach(async () => {
  jest.clearAllMocks();
  process.env.LLM_API_KEY = 'mock-llm-key';
  await ResultsCache.deleteMany({});
});

const REGION = {
  type: 'Polygon',
  coordinates: [[[76.5, 11.9], [77.5, 11.9], [77.5, 12.5], [76.5, 12.5], [76.5, 11.9]]]
};

const trendBody = {
  region: REGION,
  metric: 'ndvi',
  startDate: '2026-01-01',
  endDate: '2026-04-01',
  interval: 'monthly'
};

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
  evidence: { region: REGION, notes: '' },
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

describe('POST /api/query/trend — ResultsCache create defects', () => {
  test('successful result is cached with tool, parameters, and a future expiresAt', async () => {
    mockCallMlService.mockResolvedValue(SUCCESS_RESULT);

    const res = await request(app).post('/api/query/trend').send(trendBody);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.cache).toEqual({ hit: false });
    expect(mockCallMlService).toHaveBeenCalledTimes(1);

    const entry = await ResultsCache.findOne({ tool: 'trend' });
    expect(entry).toBeTruthy();
    expect(entry.tool).toBe('trend');
    expect(entry.parameters).toEqual({
      region: REGION,
      metric: 'ndvi',
      startDate: '2026-01-01',
      endDate: '2026-04-01',
      interval: 'monthly'
    });
    expect(entry.expiresAt).toBeInstanceOf(Date);
    expect(entry.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(entry.result.series).toHaveLength(2);
  });

  test('second identical request is served from cache (cache hit, ML not called again)', async () => {
    mockCallMlService.mockResolvedValue(SUCCESS_RESULT);

    const first = await request(app).post('/api/query/trend').send(trendBody);
    expect(first.status).toBe(200);

    jest.clearAllMocks();

    const second = await request(app).post('/api/query/trend').send(trendBody);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('success');
    expect(second.body.cache).toEqual(expect.objectContaining({ hit: true }));
    expect(mockCallMlService).not.toHaveBeenCalled();
    expect(second.body.result).toEqual(first.body.result);
  });

  test('different metric is a cache miss', async () => {
    mockCallMlService.mockResolvedValue(SUCCESS_RESULT);
    await request(app).post('/api/query/trend').send(trendBody);

    jest.clearAllMocks();
    mockCallMlService.mockResolvedValue(SUCCESS_RESULT);

    const ndwi = await request(app).post('/api/query/trend').send({ ...trendBody, metric: 'ndwi' });
    expect(ndwi.status).toBe(200);
    expect(ndwi.body.cache).toEqual({ hit: false });
    expect(mockCallMlService).toHaveBeenCalledTimes(1);
    expect(await ResultsCache.countDocuments()).toBe(2);
  });

  test('failed ML result is served as a failure and never cached', async () => {
    mockCallMlService.mockResolvedValue(FAILED_RESULT);

    const res = await request(app).post('/api/query/trend').send(trendBody);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.confidence).toBe(0);
    expect(await ResultsCache.countDocuments()).toBe(0);
  });

  test('labeled mock/fallback result is served but never cached as real data', async () => {
    mockCallMlService.mockResolvedValue(MOCK_RESULT);

    const res = await request(app).post('/api/query/trend').send(trendBody);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.cache).toEqual({ hit: false });
    expect(res.body.result.series).toHaveLength(2);
    expect(await ResultsCache.countDocuments()).toBe(0);
    expect(res.body.executionTrace.some(e =>
      (e.details || e.detail || '').includes('mock') && (e.details || e.detail || '').includes('not cached')
    )).toBe(true);
  });

  test('covering superset cache entry still serves a narrower request without ML', async () => {
    mockCallMlService.mockResolvedValue(SUCCESS_RESULT);

    // Seed a wider-range cached entry directly (as a previous request would).
    await ResultsCache.create({
      tool: 'trend',
      metric: 'ndvi',
      region: REGION,
      regionKey: JSON.stringify({ type: REGION.type, coordinates: REGION.coordinates }),
      dateRange: { start: new Date('2025-01-01'), end: new Date('2026-12-31') },
      series: SUCCESS_RESULT.result.series.map(p => ({ date: new Date(p.date), value: p.value })),
      interval: 'monthly',
      parameters: { region: REGION, metric: 'ndvi', startDate: '2025-01-01', endDate: '2026-12-31', interval: 'monthly' },
      result: SUCCESS_RESULT.result,
      evidence: SUCCESS_RESULT.evidence,
      confidence: 0.87,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    jest.clearAllMocks();

    const res = await request(app).post('/api/query/trend').send(trendBody);
    expect(res.status).toBe(200);
    expect(res.body.cache).toEqual(expect.objectContaining({ hit: true }));
    expect(mockCallMlService).not.toHaveBeenCalled();
  });

  test('validation still rejects malformed trend requests', async () => {
    const res = await request(app).post('/api/query/trend').send({ region: REGION, metric: 'ndvi' });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('rejected');
    expect(await ResultsCache.countDocuments()).toBe(0);
    expect(mockCallMlService).not.toHaveBeenCalled();
  });
});