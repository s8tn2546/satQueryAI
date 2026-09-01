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
const { default: Tile } = await import('../src/models/Tile.js');

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seedTools();
  process.env.LLM_API_KEY = 'mock-llm-key';
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  mockCallMlService.mockReset();
  await mongoose.connection.collection('queries').deleteMany({});
  await mongoose.connection.collection('tiles').deleteMany({});
});

async function createTile(overrides = {}) {
  return Tile.create({
    source: 'benchmark-upload',
    modality: 'optical',
    format: 'png',
    filePath: '/tmp/fake.png',
    validated: true,
    validationDetails: {},
    ...overrides
  });
}

describe('Milestone 2 — answerComposer fallback understands real ML snake_case keys', () => {

  it('NDVI — uses result.mean from the real ML schema', async () => {
    mockCallMlService.mockResolvedValue({
      tool: 'ndvi',
      status: 'success',
      result: {
        index: 'ndvi',
        mean: 0.62,
        median: 0.65,
        min: 0.1,
        max: 0.9,
        valid_pixel_count: 5000,
        total_pixel_count: 10000,
        warnings: []
      },
      evidence: { image: 'tid', region: {} },
      confidence: 0.91,
      metadata: {}
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'Calculate the NDVI for this image.', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.answerText).toContain('NDVI value: 0.62');
    expect(res.body.answerText).not.toContain('NaN');
    expect(res.body.answerText).not.toContain('Infinity');
  });

  it('NDWI — uses result.mean from the real ML schema', async () => {
    mockCallMlService.mockResolvedValue({
      tool: 'ndwi',
      status: 'success',
      result: { index: 'ndwi', mean: 0.45, valid_pixel_count: 1000, warnings: [] },
      evidence: { image: 'tid', region: {} },
      confidence: 0.9,
      metadata: {}
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'Calculate NDWI for this image.', imageRefs: [String(tile._id)] });

    expect(res.body.answerText).toContain('NDWI value: 0.45');
  });

  it('CHANGE — uses change_percentage and mean/max difference (no summary in real ML)', async () => {
    mockCallMlService.mockResolvedValue({
      tool: 'change',
      status: 'success',
      result: {
        total_pixels: 40000,
        valid_pixels: 39000,
        changed_pixels: 4836,
        change_percentage: 12.4,
        mean_difference: 0.05,
        max_difference: 0.18,
        threshold: 0.12,
        threshold_source: 'otsu',
        aligned: true,
        warnings: []
      },
      evidence: { image1: 't1', image2: 't2', region: {} },
      confidence: 0.85,
      metadata: {}
    });

    const t1 = await createTile({ captureDate: new Date('2025-01-01') });
    const t2 = await createTile({ captureDate: new Date('2026-01-01') });

    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'What changed between these two dates, and where did the change occur?',
        imageRefs: [String(t1._id), String(t2._id)]
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.answerText).toContain('Change detected: 12.4%');
    expect(res.body.answerText).toContain('mean difference 0.05');
    expect(res.body.answerText).toContain('max difference 0.18');
  });

  it('AREA — uses area_km2 / area_m2 / area_ha from the real ML schema', async () => {
    mockCallMlService.mockResolvedValue({
      tool: 'area',
      status: 'success',
      result: {
        area_km2: 12.45,
        area_ha: 1245,
        area_m2: 12450000,
        valid_pixel_count: 500000,
        resolution_m: 5,
        feature_type: 'water body',
        warnings: []
      },
      evidence: { image: 'tid', region: {} },
      confidence: 0.93,
      metadata: {}
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'Calculate the surface area of the water body in this image.', imageRefs: [String(tile._id)] });

    expect(res.body.status).toBe('success');
    expect(res.body.answerText).toContain('Calculated area: 12.45 km²');
  });

  it('legacy camelCase fixtures still work (value / changePercentage / areaKm2)', async () => {
    mockCallMlService.mockResolvedValueOnce({
      tool: 'ndvi',
      status: 'success',
      result: { value: 0.64, map: '/x.png' },
      evidence: {},
      confidence: 0.9,
      metadata: {}
    });
    let tile = await createTile();
    let res = await request(app)
      .post('/api/query')
      .send({ queryText: 'Calculate the NDVI for this image.', imageRefs: [String(tile._id)] });
    expect(res.body.answerText).toContain('NDVI value: 0.64');

    mockCallMlService.mockResolvedValueOnce({
      tool: 'area',
      status: 'success',
      result: { areaKm2: 10.2, featureType: 'water body', pixelCount: 1000 },
      evidence: {},
      confidence: 0.9,
      metadata: {}
    });
    tile = await createTile();
    res = await request(app)
      .post('/api/query')
      .send({ queryText: 'Calculate the area of the water body.', imageRefs: [String(tile._id)] });
    expect(res.body.answerText).toContain('Calculated area: 10.2 km²');

    mockCallMlService.mockResolvedValueOnce({
      tool: 'change',
      status: 'success',
      result: { changePercentage: 7.5, summary: 'legacy summary text', changeMaskUrl: null },
      evidence: {},
      confidence: 0.8,
      metadata: {}
    });
    const t1 = await createTile({ captureDate: new Date('2025-01-01') });
    const t2 = await createTile({ captureDate: new Date('2026-01-01') });
    res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'What changed between these two dates?',
        imageRefs: [String(t1._id), String(t2._id)]
      });
    expect(res.body.answerText).toBe('legacy summary text');
  });

  it('never emits NaN or Infinity from non-finite ML values', async () => {
    mockCallMlService.mockResolvedValue({
      tool: 'area',
      status: 'success',
      result: { area_km2: NaN, area_ha: Number.POSITIVE_INFINITY, feature_type: 'water' },
      evidence: {},
      confidence: 0.9,
      metadata: {}
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'Calculate the area of the water body.', imageRefs: [String(tile._id)] });

    expect(res.body.status).toBe('success');
    expect(res.body.answerText).not.toMatch(/NaN|Infinity/);
    // non-finite values must not be fabricated — should fall through to the raw result
    expect(res.body.answerText).toContain('Analysis complete');
  });
});