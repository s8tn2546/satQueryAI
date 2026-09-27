/**
 * Behavioral tests for the hardened /api/query/trend contract.
 *
 * Covers the defects found in the trend audit:
 * - a duplicate, unreachable POST /api/query/trend route shadowed by query.js
 * - cache lookups that ignored `tool`, the AOI scope and expiry
 * - a cache lookup that ignored `interval`, so monthly could be served a yearly series
 * - a direct route that returned raw ML output with no trendStats/observations
 * - a confidence value blended from a hardcoded heuristic instead of the real one
 */

import { jest } from '@jest/globals';

const REGION = {
  type: 'Polygon',
  coordinates: [[[77.0, 28.0], [77.2, 28.0], [77.2, 28.2], [77.0, 28.2], [77.0, 28.0]]]
};
const AOI = {
  type: 'Polygon',
  coordinates: [[[77.05, 28.05], [77.10, 28.05], [77.10, 28.10], [77.05, 28.10], [77.05, 28.05]]]
};

const SERIES = [
  { date: '2021-01-15', value: 0.42, valid_pixels: 120 },
  { date: '2021-02-15', value: 0.48, valid_pixels: 118 },
  { date: '2021-03-15', value: 0.55, valid_pixels: 121 }
];

function mlSuccess(overrides = {}) {
  return {
    tool: 'trend',
    status: 'success',
    confidence: 0.8,
    result: {
      metric: 'ndvi',
      interval: 'monthly',
      source: 'gee',
      collection: 'COPERNICUS/S2_SR_HARMONIZED',
      band_mapping: { ndvi: 'B8' },
      quality_mask: true,
      region: {
        type: 'Polygon',
        crs: 'EPSG:4326',
        bounds: { west: 77.0, south: 28.0, east: 77.2, north: 28.2 }
      },
      analyzedRegion: {
        type: 'Polygon',
        crs: 'EPSG:4326',
        bounds: { west: 77.0, south: 28.0, east: 77.2, north: 28.2 }
      },
      aoiScope: {
        aoiApplied: false,
        aoiScope: 'region',
        aoiStatus: 'not_requested',
        crs: 'EPSG:4326',
        requestedBounds: { west: 77.0, south: 28.0, east: 77.2, north: 28.2 },
        analyzedBounds: { west: 77.0, south: 28.0, east: 77.2, north: 28.2 }
      },
      date_range: { start: '2021-01-01', end: '2021-03-31' },
      series: SERIES,
      trend: {
        observation_count: 3,
        missing_count: 0,
        sufficient_for_trend: true,
        slope: 0.00042,
        direction: 'increasing',
        percentage_change: 30.95
      },
      warnings: []
    },
    evidence: { metric: 'ndvi', region_crs: 'EPSG:4326', aoi_applied: false },
    metadata: { data_source: 'gee' },
    ...overrides
  };
}

const mockCallMlService = jest.fn();
const mockCreate = jest.fn();
const mockFindOne = jest.fn();
const sortMock = jest.fn();
const queryObj = { _id: 'q1' };
const mockQueryCreate = jest.fn(() => Promise.resolve(queryObj));

jest.unstable_mockModule('../src/services/mlServiceClient.js', () => ({
  default: { callMlService: (...a) => mockCallMlService(...a) }
}));
jest.unstable_mockModule('../src/models/ResultsCache.js', () => ({
  default: { create: (...a) => mockCreate(...a), findOne: (...a) => mockFindOne(...a) }
}));
jest.unstable_mockModule('../src/models/Query.js', () => ({
  default: { create: (...a) => mockQueryCreate(...a) }
}));
jest.unstable_mockModule('../src/agents/answerComposer.js', () => ({
  composeAnswer: jest.fn(async (_q, _t, toolResults, _tr, ctx) => {
    const conf = toolResults?.[0]?.confidence;
    return `trend answer (confidence ${conf}, ctx ${ctx?.confidence})`;
  })
}));

const { default: express } = await import('express');
const { default: queryRouter } = await import('../src/routes/query.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/query', queryRouter);
  return app;
}

let app;
beforeEach(() => {
  jest.clearAllMocks();
  app = makeApp();
  mockFindOne.mockReturnValue({ sort: sortMock });
  sortMock.mockResolvedValue(null);
  mockCreate.mockResolvedValue({});
  mockQueryCreate.mockResolvedValue(queryObj);
});

async function post(body) {
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/query/trend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  server.close();
  return { status: res.status, body: json };
}

const baseBody = {
  region: REGION, metric: 'ndvi',
  startDate: '2021-01-01', endDate: '2021-03-31', interval: 'monthly'
};

describe('POST /api/query/trend — single authoritative route', () => {
  test('the duplicate routes/trend.js module no longer exists', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    expect(fs.existsSync(path.join(dir, '..', 'src', 'routes', 'trend.js'))).toBe(false);
  });

  test('the shadowed mount is gone from index.js', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const index = fs.readFileSync(path.join(dir, '..', 'src', 'index.js'), 'utf8');
    expect(index).not.toMatch(/trendRouter/);
  });
});

describe('POST /api/query/trend — cache identity', () => {
  test('the lookup is scoped to the trend tool and excludes expired entries', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess());
    await post(baseBody);
    const cond = mockFindOne.mock.calls[0][0];
    expect(cond.tool).toBe('trend');
    expect(cond.expiresAt).toEqual({ $gt: expect.any(Date) });
  });

  test('the lookup filters on interval so monthly cannot read a yearly series', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess());
    await post(baseBody);
    expect(mockFindOne.mock.calls[0][0].interval).toBe('monthly');
    expect(mockCreate.mock.calls[0][0].interval).toBe('monthly');
  });

  test('a yearly request does not reuse a monthly cache entry', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess());
    await post({ ...baseBody, interval: 'yearly' });
    expect(mockFindOne.mock.calls[0][0].interval).toBe('yearly');
  });

  test('an AOI-scoped request looks up the AOI scope, not the unscoped key', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess());
    await post({ ...baseBody, aoi: AOI });
    const cond = mockFindOne.mock.calls[0][0];
    expect(cond.aoiKey).toBe(JSON.stringify({ type: AOI.type, coordinates: AOI.coordinates }));
  });

  test('an unscoped request looks up the null AOI key', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess());
    await post(baseBody);
    expect(mockFindOne.mock.calls[0][0].aoiKey).toBeNull();
  });

  test('the stored cache entry records the AOI scope', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess());
    await post({ ...baseBody, aoi: AOI });
    expect(mockCreate.mock.calls[0][0].aoiKey).toBe(
      JSON.stringify({ type: AOI.type, coordinates: AOI.coordinates })
    );
  });

  test('the cache parameters contract is unchanged', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess());
    await post(baseBody);
    expect(mockCreate.mock.calls[0][0].parameters).toEqual({
      region: REGION, metric: 'ndvi',
      startDate: '2021-01-01', endDate: '2021-03-31', interval: 'monthly'
    });
  });
});

describe('POST /api/query/trend — AOI is forwarded, not dropped', () => {
  test('the AOI reaches the ML service when supplied', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess());
    await post({ ...baseBody, aoi: AOI, aoiCrs: 'EPSG:4326' });
    const [, payload] = mockCallMlService.mock.calls[0];
    expect(payload.aoi).toEqual(AOI);
    expect(payload.aoi_crs).toBe('EPSG:4326');
  });

  test('no aoi key is sent at all when none was requested', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess());
    await post(baseBody);
    const [, payload] = mockCallMlService.mock.calls[0];
    expect('aoi' in payload).toBe(false);
    expect('aoi_crs' in payload).toBe(false);
  });

  test('a malformed AOI is rejected before any ML call', async () => {
    const { status, body } = await post({ ...baseBody, aoi: { type: 'Point', coordinates: [1, 2] } });
    expect(status).toBe(400);
    expect(body.status).toBe('rejected');
    expect(mockCallMlService).not.toHaveBeenCalled();
  });

  test('an empty aoiCrs is rejected', async () => {
    const { status } = await post({ ...baseBody, aoi: AOI, aoiCrs: '   ' });
    expect(status).toBe(400);
    expect(mockCallMlService).not.toHaveBeenCalled();
  });
});

describe('POST /api/query/trend — stable result contract', () => {
  test('the response carries region CRS and scope', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess());
    const { body } = await post(baseBody);
    expect(body.result.regionCrs).toBe('EPSG:4326');
    expect(body.result.region.crs).toBe('EPSG:4326');
    expect(body.result.aoiScope.aoiApplied).toBe(false);
    expect(body.result.analyzedRegion).toBeTruthy();
  });

  test('the response carries the analyzer-derived trend contract', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess());
    const { body } = await post(baseBody);
    expect(body.result.observations).toHaveLength(3);
    expect(body.result.trendStats).toBeTruthy();
    expect(body.result.trendStats.validObservationsCount).toBe(3);
    expect(body.result.trendStats.trendDirection).toBe('Increasing');
    expect(body.result.qualityCounts.good).toBe(3);
    expect(Array.isArray(body.result.anomalies)).toBe(true);
  });

  test('the ML service series is preserved unchanged', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess());
    const { body } = await post(baseBody);
    expect(body.result.series).toEqual(SERIES);
    expect(body.result.trend.observation_count).toBe(3);
    expect(body.result.sufficientForTrend).toBe(true);
  });

  test('confidence is the value the ML service computed', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess({ confidence: 0.8 }));
    const { body } = await post(baseBody);
    expect(body.confidence).toBe(0.8);
    expect(body.result.confidence).toBe(0.8);
  });

  test('a one-observation result is not reported as a trend', async () => {
    const one = mlSuccess();
    one.result.series = [{ date: '2021-01-15', value: 0.42, valid_pixels: 120 }];
    one.result.trend = {
      observation_count: 1, missing_count: 0, sufficient_for_trend: false,
      slope: null, direction: 'insufficient-data', percentage_change: null
    };
    mockCallMlService.mockResolvedValue(one);
    const { body } = await post(baseBody);
    expect(body.result.sufficientForTrend).toBe(false);
    expect(body.result.trendStats.trendDirection).toBe('Insufficient data');
    expect(body.result.trendStats.slope).toBeNull();
  });

  test('a NaN/inf value is excluded rather than reported as a trend', async () => {
    const bad = mlSuccess();
    bad.result.series = [
      { date: '2021-01-15', value: 0.42, valid_pixels: 120 },
      { date: '2021-02-15', value: null, valid_pixels: 0 },
      { date: '2021-03-15', value: 0.55, valid_pixels: 121 }
    ];
    mockCallMlService.mockResolvedValue(bad);
    const { body } = await post(baseBody);
    expect(body.result.qualityCounts.excluded).toBe(1);
    const excluded = body.result.observations.find(o => o.quality === 'EXCLUDED');
    expect(excluded.value).toBeNull();
  });

  test('the result is cache-faithful: a hit equals the miss that produced it', async () => {
    mockCallMlService.mockResolvedValue(mlSuccess());
    const first = await post(baseBody);
    expect(first.body.cache.hit).toBe(false);
    const cachedDoc = { ...mockCreate.mock.calls[0][0] };
    sortMock.mockResolvedValue({ ...cachedDoc, computedAt: new Date() });
    const second = await post(baseBody);
    expect(second.body.cache.hit).toBe(true);
    expect(second.body.result).toEqual(first.body.result);
  });
});

describe('POST /api/query/trend — provider honesty', () => {
  test('an ML failure stays a failure and is not cached', async () => {
    mockCallMlService.mockResolvedValue({
      tool: 'trend', status: 'failed', confidence: 0,
      result: { error: 'GEE credentials unavailable' }
    });
    const { status, body } = await post(baseBody);
    expect(status).toBe(200);
    expect(body.status).toBe('failed');
    expect(body.confidence).toBe(0);
    expect(body.result.series).toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('no trend is invented when the provider is unavailable', async () => {
    mockCallMlService.mockRejectedValue(new Error('ECONNREFUSED'));
    const { body } = await post(baseBody);
    expect(body.status).toBe('failed');
    expect(body.result).toEqual({});
    expect(body.confidence).toBe(0);
  });
});
