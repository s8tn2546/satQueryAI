import { jest } from '@jest/globals';

const mockCallMlService = jest.fn();

jest.unstable_mockModule('../src/services/mlServiceClient.js', () => ({
  default: { callMlService: mockCallMlService }
}));

const { MongoMemoryServer } = await import('mongodb-memory-server');
const mongoose = (await import('mongoose')).default;
const request = (await import('supertest')).default;
const { default: app } = await import('../src/index.js');
const { default: ResultsCache } = await import('../src/models/ResultsCache.js');

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  process.env.LLM_API_KEY = 'mock-llm-key';
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  mockCallMlService.mockReset();
  await mongoose.connection.collection('resultscaches').deleteMany({});
});

const MOCK_REGION = {
  type: 'Polygon',
  coordinates: [[[77.0, 28.0], [77.1, 28.0], [77.1, 28.1], [77.0, 28.1], [77.0, 28.0]]]
};

const VALID_TREND = {
  tool: 'trend',
  status: 'success',
  result: {
    metric: 'ndvi',
    region: { type: 'Polygon', bounds: { west: 77, south: 28, east: 77.1, north: 28.1 } },
    date_range: { start: '2025-01-01', end: '2026-01-01' },
    interval: 'monthly',
    series: [
      { date: '2025-01-01', value: 0.52 },
      { date: '2025-04-01', value: 0.58 },
      { date: '2025-07-01', value: 0.65 }
    ],
    trend: { slope: 0.025, direction: 'increasing', observation_count: 3 },
    warnings: []
  },
  evidence: { metric: 'ndvi', region: MOCK_REGION, data_source: 'mock' },
  confidence: 0.8,
  metadata: { data_source: 'mock' }
};

function trendBody(overrides = {}) {
  return {
    region: MOCK_REGION,
    metric: 'ndvi',
    startDate: '2025-01-01',
    endDate: '2026-01-01',
    ...overrides
  };
}

describe('Milestone 2 — POST /api/query/trend two-phase cache (BACKEND.md §10 / §15.5)', () => {

  it('cache miss → calls ML /trend, stores result, returns success with cache.hit=false', async () => {
    mockCallMlService.mockResolvedValue(VALID_TREND);

    const res = await request(app)
      .post('/api/query/trend')
      .send(trendBody());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.taskType).toBe('TREND');
    expect(res.body.cache).toEqual({ hit: false });
    expect(mockCallMlService).toHaveBeenCalledWith('/trend', expect.objectContaining({
      region: MOCK_REGION,
      metric: 'ndvi',
      start_date: '2025-01-01',
      end_date: '2026-01-01',
      interval: 'monthly'
    }));
    expect(res.body.result.series).toHaveLength(3);
    expect(res.body.answerText).toContain('3 data point(s)');

    // result was persisted
    const stored = await ResultsCache.find({});
    expect(stored).toHaveLength(1);
    expect(stored[0].metric).toBe('ndvi');
    expect(stored[0].regionKey).toBeTruthy();
    expect(stored[0].series).toHaveLength(3);
  });

  it('cache hit → identical request returns cached result without calling ML again', async () => {
    mockCallMlService.mockResolvedValue(VALID_TREND);

    const first = await request(app).post('/api/query/trend').send(trendBody());
    expect(first.body.cache).toEqual({ hit: false });
    expect(mockCallMlService).toHaveBeenCalledTimes(1);

    const second = await request(app).post('/api/query/trend').send(trendBody());
    expect(second.status).toBe(200);
    expect(second.body.cache.hit).toBe(true);
    expect(second.body.status).toBe('success');
    expect(second.body.result.series).toEqual(VALID_TREND.result.series);
    // ML not consulted again
    expect(mockCallMlService).toHaveBeenCalledTimes(1);

    // still only one cache entry (no duplicate on exact match)
    const stored = await ResultsCache.find({});
    expect(stored).toHaveLength(1);
  });

  it('cache superset → narrower date range is served by a covering cached entry', async () => {
    mockCallMlService.mockResolvedValue(VALID_TREND);

    // First request covers the whole year 2025.
    await request(app).post('/api/query/trend').send(trendBody());
    expect(mockCallMlService).toHaveBeenCalledTimes(1);

    // Narrower request (middle of 2025) should reuse the cached range.
    const narrower = await request(app)
      .post('/api/query/trend')
      .send(trendBody({ startDate: '2025-04-01', endDate: '2025-07-31' }));

    expect(narrower.body.cache.hit).toBe(true);
    expect(mockCallMlService).toHaveBeenCalledTimes(1);
  });

  it('ML failure → honest failed response, failure is NOT cached', async () => {
    mockCallMlService.mockResolvedValue({
      tool: 'trend',
      status: 'failed',
      result: { error: 'Historical trend could not use real GEE data: no creds' },
      evidence: {},
      confidence: 0.0,
      metadata: {}
    });

    const first = await request(app)
      .post('/api/query/trend')
      .send(trendBody());

    expect(first.status).toBe(200);
    expect(first.body.status).toBe('failed');
    expect(first.body.answerText).toContain('no creds');
    expect(first.body.confidence).toBe(0);

    // nothing cached
    expect(await ResultsCache.find({})).toHaveLength(0);

    // retry still consults ML (no cached failure)
    const second = await request(app)
      .post('/api/query/trend')
      .send(trendBody());
    expect(second.body.status).toBe('failed');
    expect(mockCallMlService).toHaveBeenCalledTimes(2);
  });

  it('ML transport failure (throw) → failed response, nothing cached', async () => {
    mockCallMlService.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app)
      .post('/api/query/trend')
      .send(trendBody());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
    expect(await ResultsCache.find({})).toHaveLength(0);
  });

  it('malformed request → 400 rejected (region/metadata/date validation)', async () => {
    const cases = [
      { body: { metric: 'ndvi', startDate: '2025-01-01', endDate: '2026-01-01' }, msg: 'region' },
      { body: trendBody({ region: { type: 'Point', coordinates: [1, 2] } }), msg: 'region' },
      { body: trendBody({ metric: 'lai' }), msg: 'metric' },
      { body: trendBody({ interval: 'weekly' }), msg: 'interval' },
      { body: trendBody({ startDate: '2025-13-01' }), msg: 'startDate' },
      { body: trendBody({ endDate: 'not-a-date' }), msg: 'endDate' },
      { body: trendBody({ startDate: '2026-01-01', endDate: '2025-01-01' }), msg: 'endDate' }
    ];

    for (const c of cases) {
      const res = await request(app).post('/api/query/trend').send(c.body);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('rejected');
      expect(res.body.taskType).toBe('TREND');
      expect(res.body.answerText).toMatch(new RegExp(c.msg, 'i'));
    }

    // no ML calls, nothing cached on rejected requests
    expect(mockCallMlService).not.toHaveBeenCalled();
    expect(await ResultsCache.find({})).toHaveLength(0);
  });

  it('different metric creates a separate cache entry (no false sharing)', async () => {
    mockCallMlService.mockImplementation(async (endpoint, payload) => ({
      ...VALID_TREND,
      result: { ...VALID_TREND.result, metric: payload.metric }
    }));

    await request(app).post('/api/query/trend').send(trendBody());
    await request(app).post('/api/query/trend').send(trendBody({ metric: 'ndwi' }));

    expect(mockCallMlService).toHaveBeenCalledTimes(2);
    const stored = await ResultsCache.find({}).sort({ metric: 1 });
    expect(stored).toHaveLength(2);
    expect(stored.map(c => c.metric)).toEqual(['ndvi', 'ndwi']);
  });
});