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
const { default: Query } = await import('../src/models/Query.js');

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
  mockCallMlService.mockResolvedValue({
    tool: 'ndvi',
    status: 'success',
    result: { mean_ndvi: 0.65, vegetation_coverage: 0.72 },
    evidence: { image: 'tile-1', region: {} },
    confidence: 0.88,
    metadata: {}
  });
  await Tile.deleteMany({});
  await Query.deleteMany({});
});

afterEach(() => {
  delete process.env.LLM_API_KEY;
});

async function createOpticalTile() {
  return Tile.create({
    source: 'sentinel-2',
    filename: 'm6-optical.tif',
    filePath: '/tmp/m6-optical.tif',
    format: 'geotiff',
    modality: 'optical'
  });
}

async function runQuery(queryText, imageRefs, extra = {}) {
  return request(app)
    .post('/api/query')
    .send({ queryText, imageRefs, ...extra });
}

describe('Agent M6 — Session-Scoped Query History', () => {
  test('persists sessionId on successful queries and groups history per session', async () => {
    const tile = await createOpticalTile();
    const refs = [tile._id.toString()];

    const resA = await runQuery('Calculate NDVI', refs, { sessionId: 'sess-alpha' });
    const resB = await runQuery('Calculate NDVI', refs, { sessionId: 'sess-beta' });
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const storedA = await Query.findById(resA.body._id);
    const storedB = await Query.findById(resB.body._id);
    expect(storedA.sessionId).toBe('sess-alpha');
    expect(storedB.sessionId).toBe('sess-beta');

    const alpha = await request(app).get('/api/query/history').query({ sessionId: 'sess-alpha' });
    expect(alpha.status).toBe(200);
    expect(alpha.body).toHaveLength(1);
    expect(alpha.body[0].sessionId).toBe('sess-alpha');

    const beta = await request(app).get('/api/query/history').query({ sessionId: 'sess-beta' });
    expect(beta.status).toBe(200);
    expect(beta.body).toHaveLength(1);
    expect(beta.body[0].sessionId).toBe('sess-beta');
  });

  test('anonymous queries persist with sessionId null and stay out of session-scoped history', async () => {
    const tile = await createOpticalTile();
    const refs = [tile._id.toString()];

    const anon = await runQuery('Calculate NDVI', refs);
    await runQuery('Calculate NDVI', refs, { sessionId: 'sess-gamma' });
    expect(anon.status).toBe(200);

    const storedAnon = await Query.findById(anon.body._id);
    expect(storedAnon.sessionId).toBeNull();
    expect(storedAnon.userId).toBeNull();

    const scoped = await request(app).get('/api/query/history').query({ sessionId: 'sess-gamma' });
    expect(scoped.body).toHaveLength(1);
    expect(scoped.body[0].sessionId).toBe('sess-gamma');

    const unscoped = await request(app).get('/api/query/history');
    expect(unscoped.status).toBe(200);
    expect(unscoped.body).toHaveLength(2);
  });

  test('rejects a non-string sessionId with the 400 rejected shape', async () => {
    const tile = await createOpticalTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'Calculate NDVI', imageRefs: [tile._id.toString()], sessionId: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('rejected');
    expect(res.body.answerText).toContain('sessionId');

    const history = await request(app).get('/api/query/history');
    expect(history.body).toHaveLength(0);
  });

  test('normalizes (trims) and caps sessionId on persisted query docs', async () => {
    const tile = await createOpticalTile();
    const refs = [tile._id.toString()];

    const res = await runQuery('Calculate NDVI', refs, { sessionId: '  sess-padded-here  ' });
    expect(res.status).toBe(200);

    const stored = await Query.findById(res.body._id);
    expect(stored.sessionId).toBe('sess-padded-here');
  });

  test('honors the limit parameter on the history endpoint', async () => {
    const tile = await createOpticalTile();
    const refs = [tile._id.toString()];

    for (let i = 0; i < 5; i += 1) {
      await runQuery('Calculate NDVI', refs, { sessionId: 'sess-limit' });
    }

    const limited = await request(app).get('/api/query/history').query({ sessionId: 'sess-limit', limit: 2 });
    expect(limited.status).toBe(200);
    expect(limited.body).toHaveLength(2);

    const all = await request(app).get('/api/query/history').query({ sessionId: 'sess-limit' });
    expect(all.body).toHaveLength(5);
  });
});