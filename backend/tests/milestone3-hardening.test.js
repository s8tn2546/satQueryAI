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
const { default: ResultsCache } = await import('../src/models/ResultsCache.js');

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
  await mongoose.connection.collection('resultscaches').deleteMany({});
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

describe('Milestone 3 — backend hardening', () => {

  describe('Input validation: pair tasks require exactly two images', () => {
    it('rejects a 3-image CHANGE_ANALYSIS request', async () => {
      const t1 = await createTile({ captureDate: new Date('2025-01-01') });
      const t2 = await createTile({ captureDate: new Date('2025-06-01') });
      const t3 = await createTile({ captureDate: new Date('2026-01-01') });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'What changed between these two dates?',
          imageRefs: [String(t1._id), String(t2._id), String(t3._id)]
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
      expect(res.body.answerText).toMatch(/exactly 2 images/i);
      // no ML consumption on rejected requests
      expect(mockCallMlService).not.toHaveBeenCalled();
    });
  });

  describe('Rejected responses report the detected task type', () => {
    it('CHANGE_ANALYSIS validation failure reports taskType CHANGE_ANALYSIS (not VQA)', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({ queryText: 'What changed between these two dates?', imageRefs: [] });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
      expect(res.body.taskType).toBe('CHANGE_ANALYSIS');

      const stored = await Query.findById(res.body._id);
      expect(stored.taskType).toBe('CHANGE_ANALYSIS');
    });
  });

  describe('GET /:id and /:id/report: malformed ids', () => {
    it('GET /api/query/not-an-id returns 400 (no leaked CastError)', async () => {
      const res = await request(app).get('/api/query/not-a-valid-id');
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toBe('Invalid query id format.');
    });

    it('GET /api/query/not-an-id/report returns 400', async () => {
      const res = await request(app).get('/api/query/not-a-valid-id/report');
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('valid-but-missing id still returns 404', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app).get(`/api/query/${fakeId}`);
      expect(res.status).toBe(404);
    });
  });

  describe('Report includes per-tool results (Milestone 2 data)', () => {
    it('GET /:id/report exposes toolResults and toolsInvoked', async () => {
      mockCallMlService.mockResolvedValue({
        tool: 'vqa',
        status: 'success',
        result: { answer: 'Roads and buildings are visible.', confidence: 0.9 },
        evidence: { image: 'tid' },
        confidence: 0.9,
        metadata: {}
      });
      const tile = await createTile();

      const postRes = await request(app)
        .post('/api/query')
        .send({ queryText: 'How many buildings are in this image?', imageRefs: [String(tile._id)] });

      const reportRes = await request(app).get(`/api/query/${postRes.body._id}/report`);
      expect(reportRes.status).toBe(200);
      expect(reportRes.body.toolsInvoked).toEqual(['vqa']);
      expect(reportRes.body.toolResults).toHaveLength(1);
      expect(reportRes.body.toolResults[0].tool).toBe('vqa');
      expect(reportRes.body.toolResults[0].status).toBe('success');
      expect(reportRes.body.toolResults[0].confidence).toBe(0.9);
      expect(reportRes.body.toolResults[0].result).toEqual({ answer: 'Roads and buildings are visible.', confidence: 0.9 });
      expect(reportRes.body.toolResults[0].evidence).toEqual({ image: 'tid' });
    });
  });

  describe('POST /api/query: malformed imageRefs rejected up-front', () => {
    it('rejects imageRefs that is not an array', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({ queryText: 'Describe this image.', imageRefs: 'abc123' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('rejected');
      expect(res.body.answerText).toMatch(/array/i);
      expect(mockCallMlService).not.toHaveBeenCalled();
    });

    it('rejects imageRefs containing a malformed id', async () => {
      const tile = await createTile();
      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Describe this image.',
          imageRefs: [String(tile._id), 'not-an-objectid']
        });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('rejected');
      expect(res.body.answerText).toMatch(/Invalid image reference/i);
    });
  });

  describe('POST /api/query/trend: concurrent E11000 dedupe', () => {
    it('serves a successful response instead of a 500 when the cache insert collides', async () => {
      mockCallMlService.mockResolvedValue({
        tool: 'trend',
        status: 'success',
        result: {
          metric: 'ndvi',
          series: [
            { date: '2025-01-01', value: 0.52 },
            { date: '2025-04-01', value: 0.58 }
          ],
          trend: { slope: 0.025, direction: 'increasing', observation_count: 2 },
          date_range: { start: '2025-01-01', end: '2025-12-31' },
          warnings: []
        },
        evidence: { metric: 'ndvi' },
        confidence: 0.8,
        metadata: {}
      });

      const createSpy = jest.spyOn(ResultsCache, 'create').mockRejectedValueOnce({ code: 11000, message: 'E11000 duplicate key error' });

      const region = {
        type: 'Polygon',
        coordinates: [[[77.0, 28.0], [77.1, 28.0], [77.1, 28.1], [77.0, 28.1], [77.0, 28.0]]]
      };

      const res = await request(app)
        .post('/api/query/trend')
        .send({ region, metric: 'ndvi', startDate: '2025-01-01', endDate: '2025-12-31' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.cache).toEqual({ hit: false });
      expect(res.body.result.series).toHaveLength(2);
      expect(createSpy).toHaveBeenCalled();
      createSpy.mockRestore();
    });
  });

  describe('POST /api/images/upload hardening', () => {
    it('rejects an unsupported file extension', async () => {
      const res = await request(app)
        .post('/api/images/upload')
        .field('modality', 'optical')
        .attach('images', Buffer.from('not-an-image'), 'evil.txt');

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('rejected');
      expect(res.body.error).toMatch(/\.txt/i);
      expect(mockCallMlService).not.toHaveBeenCalled();
    });

    it('rejects an invalid modality', async () => {
      const res = await request(app)
        .post('/api/images/upload')
        .field('modality', 'infrared')
        .attach('images', Buffer.from('png-bytes'), 'test.png');

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('rejected');
      expect(res.body.error).toMatch(/modality/i);
    });

    it('rejects an invalid source', async () => {
      const res = await request(app)
        .post('/api/images/upload')
        .field('source', 'hacker-source')
        .field('modality', 'optical')
        .attach('images', Buffer.from('png-bytes'), 'test.png');

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('rejected');
      expect(res.body.error).toMatch(/source/i);
    });

    it('returns JSON (not HTML) when more than 5 files are uploaded', async () => {
      let req = request(app).post('/api/images/upload');
      for (let i = 0; i < 6; i++) {
        req = req.attach('images', Buffer.from('png-bytes'), `img${i}.png`);
      }
      const res = await req;

      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('rejected');
    });

    it('still accepts a valid upload end-to-end', async () => {
      mockCallMlService.mockResolvedValue({
        tool: 'validate',
        status: 'success',
        confidence: 0.9,
        result: { valid: true, validation_status: 'valid', errors: [], warnings: [] }
      });

      const res = await request(app)
        .post('/api/images/upload')
        .field('modality', 'optical')
        .attach('images', Buffer.from('fake-tiff-content'), 'scene.tif');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.tileId).toBeTruthy();
    });
  });
});