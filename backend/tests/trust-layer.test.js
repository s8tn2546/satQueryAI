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

const VALID_VQA_RESULT = {
  tool: 'vqa',
  status: 'success',
  result: { answer: 'Dense urban layout with road network visible.', confidence: 0.9 },
  evidence: { image: 'tid', region: {} },
  confidence: 0.9,
  metadata: {}
};

const SECTION6_KEYS = ['answerText', 'taskType', 'result', 'evidence', 'confidence', 'executionTrace', 'status'];

function assertSection6Shape(body) {
  for (const key of SECTION6_KEYS) {
    expect(body).toHaveProperty(key);
  }
  expect(typeof body.answerText).toBe('string');
  expect(body.answerText.length).toBeGreaterThan(0);
  expect(['VQA', 'CAPTION', 'GROUNDING', 'CHANGE_ANALYSIS', 'OPTICAL_SAR', 'NDVI', 'NDWI', 'AREA', 'TREND']).toContain(body.taskType);
  expect(typeof body.result).toBe('object');
  expect(body.evidence).toHaveProperty('images');
  expect(Array.isArray(body.evidence.images)).toBe(true);
  expect(body.evidence).toHaveProperty('region');
  expect(typeof body.confidence).toBe('number');
  expect(body.confidence).toBeGreaterThanOrEqual(0);
  expect(body.confidence).toBeLessThanOrEqual(1);
  expect(Array.isArray(body.executionTrace)).toBe(true);
  expect(body.executionTrace.length).toBeGreaterThan(0);
  for (const entry of body.executionTrace) {
    expect(entry).toHaveProperty('step');
    expect(entry).toHaveProperty('detail');
    expect(entry).toHaveProperty('timestamp');
  }
  expect(['success', 'partial', 'failed', 'rejected']).toContain(body.status);
}

describe('§15.4 — Trust Layer Surfacing', () => {

  describe('GET /api/query/:id — full stored result including trace', () => {
    it('returns the full query document with executionTrace', async () => {
      mockCallMlService.mockResolvedValue(VALID_VQA_RESULT);
      const tile = await createTile();

      const postRes = await request(app)
        .post('/api/query')
        .send({ queryText: 'How many roads are in this image?', imageRefs: [String(tile._id)] });

      expect(postRes.status).toBe(200);
      const queryId = postRes.body._id;
      expect(queryId).toBeTruthy();

      const getRes = await request(app).get(`/api/query/${queryId}`);
      expect(getRes.status).toBe(200);

      expect(getRes.body).toHaveProperty('queryText', 'How many roads are in this image?');
      expect(getRes.body).toHaveProperty('answerText');
      expect(getRes.body).toHaveProperty('taskType');
      expect(getRes.body).toHaveProperty('status');
      expect(getRes.body).toHaveProperty('confidence');
      expect(getRes.body).toHaveProperty('evidence');
      expect(getRes.body).toHaveProperty('result');
      expect(getRes.body).toHaveProperty('executionTrace');
      expect(Array.isArray(getRes.body.executionTrace)).toBe(true);
      expect(getRes.body.executionTrace.length).toBeGreaterThan(0);
    });

    it('returns 404 for a non-existent query id', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app).get(`/api/query/${fakeId}`);
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('status', 'failed');
    });

    it('persists rejected queries and returns them via GET /:id', async () => {
      const postRes = await request(app)
        .post('/api/query')
        .send({ queryText: 'What changed between these two dates?', imageRefs: [] });

      expect(postRes.body.status).toBe('rejected');
      const queryId = postRes.body._id;
      expect(queryId).toBeTruthy();

      const getRes = await request(app).get(`/api/query/${queryId}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.status).toBe('rejected');
      expect(Array.isArray(getRes.body.executionTrace)).toBe(true);
    });
  });

  describe('GET /api/query/:id/report — bundled downloadable report', () => {
    it('returns a report with answer, evidence, confidence, and trace', async () => {
      mockCallMlService.mockResolvedValue(VALID_VQA_RESULT);
      const tile = await createTile();

      const postRes = await request(app)
        .post('/api/query')
        .send({ queryText: 'How many buildings are in this image?', imageRefs: [String(tile._id)] });

      const queryId = postRes.body._id;
      const reportRes = await request(app).get(`/api/query/${queryId}/report`);

      expect(reportRes.status).toBe(200);
      expect(reportRes.body).toHaveProperty('queryId');
      expect(reportRes.body).toHaveProperty('queryText', 'How many buildings are in this image?');
      expect(reportRes.body).toHaveProperty('answerText');
      expect(typeof reportRes.body.answerText).toBe('string');
      expect(reportRes.body.answerText.length).toBeGreaterThan(0);
      expect(reportRes.body).toHaveProperty('taskType');
      expect(reportRes.body).toHaveProperty('status');
      expect(reportRes.body).toHaveProperty('confidence');
      expect(typeof reportRes.body.confidence).toBe('number');
      expect(reportRes.body).toHaveProperty('evidence');
      expect(reportRes.body.evidence).toHaveProperty('images');
      expect(reportRes.body).toHaveProperty('result');
      expect(reportRes.body).toHaveProperty('executionTrace');
      expect(Array.isArray(reportRes.body.executionTrace)).toBe(true);
      expect(reportRes.body.executionTrace.length).toBeGreaterThan(0);
      expect(reportRes.body).toHaveProperty('generatedAt');
    });

    it('returns 404 for report on non-existent query', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app).get(`/api/query/${fakeId}/report`);
      expect(res.status).toBe(404);
    });

    it('report trace entries all have step, detail, timestamp', async () => {
      mockCallMlService.mockResolvedValue(VALID_VQA_RESULT);
      const tile = await createTile();

      const postRes = await request(app)
        .post('/api/query')
        .send({ queryText: 'How many roads are visible here?', imageRefs: [String(tile._id)] });

      const reportRes = await request(app).get(`/api/query/${postRes.body._id}/report`);
      for (const entry of reportRes.body.executionTrace) {
        expect(entry).toHaveProperty('step');
        expect(entry).toHaveProperty('detail');
        expect(entry).toHaveProperty('timestamp');
      }
    });
  });

  describe('Section 6 shape on every response path', () => {
    it('success path — matches Section 6 shape exactly', async () => {
      mockCallMlService.mockResolvedValue(VALID_VQA_RESULT);
      const tile = await createTile();

      const res = await request(app)
        .post('/api/query')
        .send({ queryText: 'How many roads are in this image?', imageRefs: [String(tile._id)] });

      expect(res.status).toBe(200);
      assertSection6Shape(res.body);
      expect(res.body.status).toBe('success');
    });

    it('rejected path (validation failure) — matches Section 6 shape exactly', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({ queryText: 'What changed between these two dates?', imageRefs: [] });

      expect(res.status).toBe(200);
      assertSection6Shape(res.body);
      expect(res.body.status).toBe('rejected');
    });

    it('rejected path (modality mismatch) — matches Section 6 shape exactly', async () => {
      const tile1 = await createTile({ modality: 'optical' });
      const tile2 = await createTile({ modality: 'optical' });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Use the optical and SAR images together to identify built-up and water-covered regions.',
          imageRefs: [String(tile1._id), String(tile2._id)]
        });

      expect(res.status).toBe(200);
      assertSection6Shape(res.body);
      expect(res.body.status).toBe('rejected');
    });

    it('failed path (ML service error) — matches Section 6 shape exactly', async () => {
      mockCallMlService.mockResolvedValue({ status: 'error', error: 'GPU OOM' });
      const tile = await createTile();

      const res = await request(app)
        .post('/api/query')
        .send({ queryText: 'Describe the vegetation.', imageRefs: [String(tile._id)] });

      expect(res.status).toBe(200);
      assertSection6Shape(res.body);
      expect(res.body.status).toBe('failed');
    });

    it('failed path (ML service network throw) — matches Section 6 shape exactly', async () => {
      mockCallMlService.mockRejectedValue(new Error('ECONNREFUSED'));
      const tile = await createTile();

      const res = await request(app)
        .post('/api/query')
        .send({ queryText: 'Describe the scene.', imageRefs: [String(tile._id)] });

      expect(res.status).toBe(200);
      assertSection6Shape(res.body);
    });

    it('rejected path (empty queryText) — 400 with Section 6 keys present', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({ queryText: '', imageRefs: [] });

      expect(res.status).toBe(400);
      for (const key of SECTION6_KEYS) {
        expect(res.body).toHaveProperty(key);
      }
      expect(res.body.status).toBe('rejected');
    });
  });
});
