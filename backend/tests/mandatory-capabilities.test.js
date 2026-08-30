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

const VALID_VQA_RESULT = {
  tool: 'vqa',
  status: 'success',
  result: { answer: 'The image shows dense urban development with roads and buildings.', confidence: 0.91 },
  evidence: { image: 'tile-id-1', region: {} },
  confidence: 0.91,
  metadata: { date: '2026-08-01' }
};

const VALID_CAPTION_RESULT = {
  tool: 'caption',
  status: 'success',
  result: { caption: 'Multispectral view showing mixed land cover: 42% urban, 35% vegetation, 23% bare soil.', keywords: ['urban', 'vegetation', 'bare soil'] },
  evidence: { image: 'tile-id-1', region: {} },
  confidence: 0.88,
  metadata: {}
};

const VALID_CHANGE_RESULT = {
  tool: 'change',
  status: 'success',
  result: { changePercentage: 12.4, summary: 'Built-up area expanded by 12.4% between the two dates.', changeMaskUrl: null },
  evidence: { image: 'tile-id-pair', region: {} },
  confidence: 0.85,
  metadata: { date_t1: '2025-01-01', date_t2: '2026-01-01' }
};

const VALID_OPTICAL_SAR_RESULT = {
  tool: 'optical_sar',
  status: 'success',
  result: { fusedLandCover: { builtUp: 38.2, water: 14.7, vegetation: 47.1 }, confidence: 0.87 },
  evidence: { image: 'tile-id-pair', region: {} },
  confidence: 0.87,
  metadata: {}
};

async function createTile(overrides = {}) {
  return Tile.create({
    source: 'benchmark-upload',
    modality: 'optical',
    format: 'png',
    filePath: '/tmp/fake-image.png',
    validated: true,
    validationDetails: {},
    ...overrides
  });
}

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

function assertSection6Shape(body) {
  expect(body).toHaveProperty('answerText');
  expect(typeof body.answerText).toBe('string');
  expect(body.answerText.length).toBeGreaterThan(0);

  expect(body).toHaveProperty('taskType');
  expect(['VQA', 'CAPTION', 'GROUNDING', 'CHANGE_ANALYSIS', 'OPTICAL_SAR', 'NDVI', 'NDWI', 'AREA', 'TREND']).toContain(body.taskType);

  expect(body).toHaveProperty('result');
  expect(typeof body.result).toBe('object');

  expect(body).toHaveProperty('evidence');
  expect(body.evidence).toHaveProperty('images');
  expect(Array.isArray(body.evidence.images)).toBe(true);
  expect(body.evidence).toHaveProperty('region');

  expect(body).toHaveProperty('confidence');
  expect(typeof body.confidence).toBe('number');
  expect(body.confidence).toBeGreaterThanOrEqual(0);
  expect(body.confidence).toBeLessThanOrEqual(1);

  expect(body).toHaveProperty('executionTrace');
  expect(Array.isArray(body.executionTrace)).toBe(true);
  expect(body.executionTrace.length).toBeGreaterThan(0);
  for (const entry of body.executionTrace) {
    expect(entry).toHaveProperty('step');
    expect(entry).toHaveProperty('detail');
    expect(entry).toHaveProperty('timestamp');
  }

  expect(body).toHaveProperty('status');
  expect(['success', 'partial', 'failed', 'rejected']).toContain(body.status);
}

describe('§15.3 — Mandatory Capability Wiring', () => {

  describe('VQA tool — single image + question → answer', () => {
    it('returns full Section 6 shape with evidence, confidence, and trace', async () => {
      mockCallMlService.mockResolvedValue(VALID_VQA_RESULT);

      const tile = await createTile();

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'How many buildings are in this satellite image?',
          imageRefs: [String(tile._id)]
        });

      expect(res.status).toBe(200);
      assertSection6Shape(res.body);
      expect(res.body.status).toBe('success');
      expect(res.body.taskType).toBe('VQA');
      expect(res.body.result).toHaveProperty('answer');
      expect(mockCallMlService).toHaveBeenCalledWith('/vqa', expect.objectContaining({
        image_path: tile.filePath
      }));
    });

    it('includes the image tileId in evidence.images', async () => {
      mockCallMlService.mockResolvedValue(VALID_VQA_RESULT);
      const tile = await createTile();

      const res = await request(app)
        .post('/api/query')
        .send({ queryText: 'Describe the vegetation in this image.', imageRefs: [String(tile._id)] });

      expect(res.status).toBe(200);
      expect(res.body.evidence.images).toContain(String(tile._id));
    });
  });

  describe('CAPTION tool — single image → caption description', () => {
    it('returns full Section 6 shape with caption result', async () => {
      mockCallMlService.mockResolvedValue(VALID_CAPTION_RESULT);

      const tile = await createTile();

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Describe the land-cover and major objects visible in this image.',
          imageRefs: [String(tile._id)]
        });

      expect(res.status).toBe(200);
      assertSection6Shape(res.body);
      expect(res.body.status).toBe('success');
      expect(res.body.taskType).toBe('CAPTION');
      expect(res.body.result).toHaveProperty('caption');
      expect(mockCallMlService).toHaveBeenCalledWith('/caption', expect.objectContaining({
        image_path: tile.filePath
      }));
    });

    it('confidence is non-zero when caption tool reports high confidence', async () => {
      mockCallMlService.mockResolvedValue(VALID_CAPTION_RESULT);
      const tile = await createTile();

      const res = await request(app)
        .post('/api/query')
        .send({ queryText: 'Describe the scene in this satellite image.', imageRefs: [String(tile._id)] });

      expect(res.body.confidence).toBeGreaterThan(0);
    });
  });

  describe('CHANGE_ANALYSIS tool — bi-temporal pair → change description', () => {
    it('returns full Section 6 shape with change result', async () => {
      mockCallMlService.mockResolvedValue(VALID_CHANGE_RESULT);

      const tileT1 = await createTile({ captureDate: new Date('2025-01-01') });
      const tileT2 = await createTile({ captureDate: new Date('2026-01-01') });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'What changed between these two dates, and where did the change occur?',
          imageRefs: [String(tileT1._id), String(tileT2._id)]
        });

      expect(res.status).toBe(200);
      assertSection6Shape(res.body);
      expect(res.body.status).toBe('success');
      expect(res.body.taskType).toBe('CHANGE_ANALYSIS');
      expect(res.body.result).toHaveProperty('changePercentage');
      expect(mockCallMlService).toHaveBeenCalledWith('/change', expect.objectContaining({
        image_t1_path: tileT1.filePath,
        image_t2_path: tileT2.filePath
      }));
    });

    it('rejects when only one image is provided for a change task', async () => {
      const tile = await createTile();

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'What changed between these two dates?',
          imageRefs: [String(tile._id)]
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
      expect(res.body.answerText).toMatch(/2 images/i);
    });
  });

  describe('OPTICAL_SAR tool — optical + SAR pair → fused result', () => {
    it('returns full Section 6 shape with fused land cover result', async () => {
      mockCallMlService.mockResolvedValue(VALID_OPTICAL_SAR_RESULT);

      const opticalTile = await createTile({ modality: 'optical' });
      const sarTile = await createTile({ modality: 'sar' });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Use the optical and SAR images together to identify built-up and water-covered regions.',
          imageRefs: [String(opticalTile._id), String(sarTile._id)]
        });

      expect(res.status).toBe(200);
      assertSection6Shape(res.body);
      expect(res.body.status).toBe('success');
      expect(res.body.taskType).toBe('OPTICAL_SAR');
      expect(res.body.result).toHaveProperty('fusedLandCover');
      expect(mockCallMlService).toHaveBeenCalledWith('/optical-sar', expect.objectContaining({
        optical_path: opticalTile.filePath,
        sar_path: sarTile.filePath
      }));
    });

    it('rejects when two optical images are provided instead of optical + SAR', async () => {
      const tile1 = await createTile({ modality: 'optical' });
      const tile2 = await createTile({ modality: 'optical' });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Use the optical and SAR images together to identify built-up and water-covered regions.',
          imageRefs: [String(tile1._id), String(tile2._id)]
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
      expect(res.body.answerText).toMatch(/optical.*sar|sar.*optical/i);
    });

    it('rejects when zero images provided for optical_sar', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Use the optical and SAR images together to identify built-up and water-covered regions.',
          imageRefs: []
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
    });
  });

  describe('ML service failure handling', () => {
    it('returns status:failed when ML service returns an error', async () => {
      mockCallMlService.mockResolvedValue({ status: 'error', error: 'Model unavailable' });

      const tile = await createTile();

      const res = await request(app)
        .post('/api/query')
        .send({ queryText: 'Describe the vegetation.', imageRefs: [String(tile._id)] });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      assertSection6Shape(res.body);
    });

    it('returns valid Section 6 shape on network error from ML service', async () => {
      mockCallMlService.mockRejectedValue(new Error('Network error'));

      const tile = await createTile();

      const res = await request(app)
        .post('/api/query')
        .send({ queryText: 'Describe the scene.', imageRefs: [String(tile._id)] });

      expect(res.status).toBe(200);
      assertSection6Shape(res.body);
    });
  });

  describe('Out-of-scope query handling', () => {
    it('returns a valid Section 6 shape for out-of-scope queries', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({ queryText: 'What is the weather forecast for tomorrow?', imageRefs: [] });

      expect(res.status).toBe(200);
      assertSection6Shape(res.body);
    });
  });

  describe('Empty queryText', () => {
    it('returns 400 with rejected status for empty queryText', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({ queryText: '', imageRefs: [] });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('rejected');
    });
  });
});
