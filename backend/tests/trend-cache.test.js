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

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await seedTools();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await ResultsCache.deleteMany({});
});

describe('Trend Cache Integration', () => {
  const trendParams = {
    region: { type: 'Point', coordinates: [77.5946, 12.9716] },
    metric: 'ndvi',
    startDate: '2023-01-01',
    endDate: '2023-12-31'
  };

  const mockTrendResult = {
    tool: 'trend',
    status: 'success',
    result: {
      trend: 'increase',
      observations: [
        { date: '2023-01-15', value: 0.45 },
        { date: '2023-06-15', value: 0.52 },
        { date: '2023-12-15', value: 0.58 }
      ],
      slope: 0.013,
      percentage_change: 28.9
    },
    evidence: { region: trendParams.region },
    confidence: 0.87,
    metadata: { data_source: 'GEE:Sentinel-2' }
  };

  test('calls ML service on first trend request (cache miss)', async () => {
    mockCallMlService.mockResolvedValue(mockTrendResult);

    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'Show the NDVI trend for Bangalore from January to December 2023',
        imageRefs: [],
        parameters: trendParams
      });

    expect(res.status).toBe(200);
    expect(mockCallMlService).toHaveBeenCalledWith(
      expect.stringContaining('/trend'),
      expect.objectContaining({
        region: trendParams.region,
        metric: trendParams.metric
      })
    );

    const cacheEntry = await ResultsCache.findOne({
      tool: 'trend',
      'parameters.metric': 'ndvi'
    });
    expect(cacheEntry).toBeTruthy();
    expect(cacheEntry.result).toBeDefined();
  });

  test('reuses cached result on second identical request (cache hit)', async () => {
    mockCallMlService.mockResolvedValue(mockTrendResult);

    const firstRes = await request(app)
      .post('/api/query')
      .send({
        queryText: 'Show NDVI trend for this region',
        imageRefs: [],
        parameters: trendParams
      });

    expect(firstRes.status).toBe(200);
    expect(mockCallMlService).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();

    const secondRes = await request(app)
      .post('/api/query')
      .send({
        queryText: 'Show NDVI trend for this region',
        imageRefs: [],
        parameters: trendParams
      });

    expect(secondRes.status).toBe(200);
    expect(mockCallMlService).not.toHaveBeenCalled();
    
    expect(secondRes.body.result).toEqual(firstRes.body.result);
    expect(secondRes.body.executionTrace.some(e => 
      e.details && e.details.includes('cache hit')
    )).toBe(true);
  });

  test('cache miss for different region parameters', async () => {
    mockCallMlService.mockResolvedValue(mockTrendResult);

    await request(app)
      .post('/api/query')
      .send({
        queryText: 'Show NDVI trend',
        imageRefs: [],
        parameters: trendParams
      });

    expect(mockCallMlService).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();

    const differentRegion = {
      ...trendParams,
      region: { type: 'Point', coordinates: [78.0, 13.0] }
    };

    await request(app)
      .post('/api/query')
      .send({
        queryText: 'Show NDVI trend',
        imageRefs: [],
        parameters: differentRegion
      });

    expect(mockCallMlService).toHaveBeenCalledTimes(1);
  });

  test('cache miss for different date range', async () => {
    mockCallMlService.mockResolvedValue(mockTrendResult);

    await request(app)
      .post('/api/query')
      .send({
        queryText: 'Show NDVI trend',
        imageRefs: [],
        parameters: trendParams
      });

    expect(mockCallMlService).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();

    const differentDates = {
      ...trendParams,
      startDate: '2024-01-01',
      endDate: '2024-12-31'
    };

    await request(app)
      .post('/api/query')
      .send({
        queryText: 'Show NDVI trend',
        imageRefs: [],
        parameters: differentDates
      });

    expect(mockCallMlService).toHaveBeenCalledTimes(1);
  });

  test('cache miss for different metric', async () => {
    mockCallMlService.mockResolvedValue({
      ...mockTrendResult,
      result: { ...mockTrendResult.result, trend: 'stable' }
    });

    await request(app)
      .post('/api/query')
      .send({
        queryText: 'Show NDVI trend',
        imageRefs: [],
        parameters: trendParams
      });

    expect(mockCallMlService).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();

    const ndwiParams = { ...trendParams, metric: 'ndwi' };

    await request(app)
      .post('/api/query')
      .send({
        queryText: 'Show NDWI trend',
        imageRefs: [],
        parameters: ndwiParams
      });

    expect(mockCallMlService).toHaveBeenCalledTimes(1);
  });

  test('cache respects TTL and expires old entries', async () => {
    mockCallMlService.mockResolvedValue(mockTrendResult);

    await request(app)
      .post('/api/query')
      .send({
        queryText: 'Show NDVI trend',
        imageRefs: [],
        parameters: trendParams
      });

    const cacheEntry = await ResultsCache.findOne({ tool: 'trend' });
    expect(cacheEntry).toBeTruthy();

    cacheEntry.expiresAt = new Date(Date.now() - 1000);
    await cacheEntry.save();

    jest.clearAllMocks();

    await request(app)
      .post('/api/query')
      .send({
        queryText: 'Show NDVI trend',
        imageRefs: [],
        parameters: trendParams
      });

    expect(mockCallMlService).toHaveBeenCalledTimes(1);
  });

  test('failed trend requests are not cached', async () => {
    mockCallMlService.mockResolvedValue({
      tool: 'trend',
      status: 'failed',
      result: { error: 'GEE authentication failed' },
      evidence: {},
      confidence: 0,
      metadata: {}
    });

    await request(app)
      .post('/api/query')
      .send({
        queryText: 'Show NDVI trend',
        imageRefs: [],
        parameters: trendParams
      });

    const cacheEntry = await ResultsCache.findOne({ tool: 'trend' });
    expect(cacheEntry).toBeFalsy();
  });

  // An AOI changes what the numbers mean, so it must be part of the cache
  // identity: a scoped series can never satisfy an unscoped request.
  test('an AOI-scoped trend is not served to an unscoped request', async () => {
    const aoi = {
      type: 'Polygon',
      coordinates: [[[77.5, 12.9], [77.6, 12.9], [77.6, 13.0], [77.5, 13.0], [77.5, 12.9]]]
    };
    mockCallMlService.mockResolvedValue(mockTrendResult);

    await request(app).post('/api/query').send({
      queryText: 'Show the NDVI trend for Bangalore from January to December 2023',
      imageRefs: [],
      parameters: { ...trendParams, aoi }
    });
    expect(mockCallMlService).toHaveBeenCalledTimes(1);
    const scopedEntry = await ResultsCache.findOne({ tool: 'trend' });
    expect(scopedEntry.aoiKey).toBe(JSON.stringify(aoi));

    // Same region/metric/dates but no AOI -> must not reuse the scoped series.
    await request(app).post('/api/query').send({
      queryText: 'Show the NDVI trend for Bangalore from January to December 2023',
      imageRefs: [],
      parameters: trendParams
    });
    expect(mockCallMlService).toHaveBeenCalledTimes(2);

    const all = await ResultsCache.find({ tool: 'trend' });
    expect(all).toHaveLength(2);
  });

  test('an unscoped trend is not served to an AOI-scoped request', async () => {
    mockCallMlService.mockResolvedValue(mockTrendResult);

    await request(app).post('/api/query').send({
      queryText: 'Show the NDVI trend for Bangalore from January to December 2023',
      imageRefs: [],
      parameters: trendParams
    });
    expect(mockCallMlService).toHaveBeenCalledTimes(1);

    await request(app).post('/api/query').send({
      queryText: 'Show the NDVI trend for Bangalore from January to December 2023',
      imageRefs: [],
      parameters: {
        ...trendParams,
        aoi: { type: 'Polygon', coordinates: [[[77.5, 12.9], [77.6, 12.9], [77.6, 13.0], [77.5, 13.0], [77.5, 12.9]]] }
      }
    });
    expect(mockCallMlService).toHaveBeenCalledTimes(2);
  });

  test('identical AOI requests do hit the cache', async () => {
    const aoi = {
      type: 'Polygon',
      coordinates: [[[77.5, 12.9], [77.6, 12.9], [77.6, 13.0], [77.5, 13.0], [77.5, 12.9]]]
    };
    mockCallMlService.mockResolvedValue(mockTrendResult);
    const body = {
      queryText: 'Show the NDVI trend for Bangalore from January to December 2023',
      imageRefs: [],
      parameters: { ...trendParams, aoi }
    };

    await request(app).post('/api/query').send(body);
    await request(app).post('/api/query').send(body);

    expect(mockCallMlService).toHaveBeenCalledTimes(1);
  });
});
