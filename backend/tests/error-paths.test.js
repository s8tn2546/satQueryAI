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

beforeEach(() => {
  jest.clearAllMocks();
});

function assertValidResponseShape(body) {
  expect(body).toHaveProperty('answerText');
  expect(body).toHaveProperty('taskType');
  expect(body).toHaveProperty('result');
  expect(body).toHaveProperty('evidence');
  expect(body.evidence).toHaveProperty('images');
  expect(body.evidence).toHaveProperty('region');
  expect(body).toHaveProperty('confidence');
  expect(body).toHaveProperty('executionTrace');
  expect(body).toHaveProperty('status');
  expect(typeof body.answerText).toBe('string');
  expect(typeof body.taskType).toBe('string');
  expect(typeof body.result).toBe('object');
  expect(Array.isArray(body.evidence.images)).toBe(true);
  expect(typeof body.evidence.region).toBe('object');
  expect(typeof body.confidence).toBe('number');
  expect(Array.isArray(body.executionTrace)).toBe(true);
  expect(['success', 'partial', 'failed', 'rejected']).toContain(body.status);
}

describe('Error Path Response Validation', () => {
  describe('Empty/missing queryText', () => {
    test('returns valid shape for empty string', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({ queryText: '', imageRefs: [] });

      expect(res.status).toBe(400);
      assertValidResponseShape(res.body);
      expect(res.body.status).toBe('rejected');
    });

    test('returns valid shape for whitespace-only string', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({ queryText: '   ', imageRefs: [] });

      expect(res.status).toBe(400);
      assertValidResponseShape(res.body);
      expect(res.body.status).toBe('rejected');
    });

    test('returns valid shape when queryText is missing', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({ imageRefs: [] });

      expect(res.status).toBe(400);
      assertValidResponseShape(res.body);
      expect(res.body.status).toBe('rejected');
    });
  });

  describe('ML service failures', () => {
    test('returns valid shape when ML service returns error status', async () => {
      const tile = await Tile.create({
        filename: 'test.tif',
        filePath: '/tmp/test.tif',
        format: 'geotiff',
        modality: 'optical'
      });

      mockCallMlService.mockResolvedValue({
        tool: 'ndvi',
        status: 'failed',
        result: { error: 'Could not identify NIR band' },
        evidence: {},
        confidence: 0,
        metadata: {}
      });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Calculate NDVI',
          imageRefs: [tile._id.toString()]
        });

      expect(res.status).toBe(200);
      assertValidResponseShape(res.body);
      expect(res.body.status).toBe('failed');
    });

    test('returns valid shape when ML service throws network error', async () => {
      const tile = await Tile.create({
        filename: 'test.tif',
        filePath: '/tmp/test.tif',
        format: 'geotiff',
        modality: 'optical'
      });

      mockCallMlService.mockRejectedValue(new Error('ECONNREFUSED'));

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Calculate NDVI',
          imageRefs: [tile._id.toString()]
        });

      expect(res.status).toBe(200);
      assertValidResponseShape(res.body);
      expect(res.body.status).toBe('failed');
    });

    test('returns valid shape when ML service times out', async () => {
      const tile = await Tile.create({
        filename: 'test.tif',
        filePath: '/tmp/test.tif',
        format: 'geotiff',
        modality: 'optical'
      });

      mockCallMlService.mockRejectedValue(new Error('Request timeout'));

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Calculate NDWI',
          imageRefs: [tile._id.toString()]
        });

      expect(res.status).toBe(200);
      assertValidResponseShape(res.body);
      expect(res.body.status).toBe('failed');
    });
  });

  describe('Validation failures', () => {
    test('returns valid shape for optical-only task with SAR image', async () => {
      const tile = await Tile.create({
        filename: 'sar.tif',
        filePath: '/tmp/sar.tif',
        format: 'geotiff',
        modality: 'sar'
      });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Calculate NDVI',
          imageRefs: [tile._id.toString()]
        });

      expect(res.status).toBe(200);
      assertValidResponseShape(res.body);
      expect(res.body.status).toBe('rejected');
    });

    test('returns valid shape for pair task with single image', async () => {
      const tile = await Tile.create({
        filename: 'single.tif',
        filePath: '/tmp/single.tif',
        format: 'geotiff',
        modality: 'optical'
      });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'What changed between these images?',
          imageRefs: [tile._id.toString()]
        });

      expect(res.status).toBe(200);
      assertValidResponseShape(res.body);
      expect(res.body.status).toBe('rejected');
    });

    test('returns valid shape for OPTICAL_SAR without both modalities', async () => {
      const tile1 = await Tile.create({
        filename: 'optical1.tif',
        filePath: '/tmp/optical1.tif',
        format: 'geotiff',
        modality: 'optical'
      });

      const tile2 = await Tile.create({
        filename: 'optical2.tif',
        filePath: '/tmp/optical2.tif',
        format: 'geotiff',
        modality: 'optical'
      });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Fuse optical and SAR',
          imageRefs: [tile1._id.toString(), tile2._id.toString()]
        });

      expect(res.status).toBe(200);
      assertValidResponseShape(res.body);
      expect(res.body.status).toBe('rejected');
    });

    test('returns valid shape for unsupported image format', async () => {
      const tile = await Tile.create({
        filename: 'test.bmp',
        filePath: '/tmp/test.bmp',
        format: 'bmp',
        modality: 'optical'
      });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'What is this?',
          imageRefs: [tile._id.toString()]
        });

      expect(res.status).toBe(200);
      assertValidResponseShape(res.body);
      expect(res.body.status).toBe('rejected');
    });

    test('returns valid shape for non-existent image ID', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Calculate NDVI',
          imageRefs: ['507f1f77bcf86cd799439011']
        });

      expect(res.status).toBe(200);
      assertValidResponseShape(res.body);
      expect(['rejected', 'failed']).toContain(res.body.status);
    });
  });

  describe('Partial success scenarios', () => {
    test('returns valid shape for partial ML service result', async () => {
      const tile = await Tile.create({
        filename: 'test.tif',
        filePath: '/tmp/test.tif',
        format: 'geotiff',
        modality: 'optical'
      });

      mockCallMlService.mockResolvedValue({
        tool: 'ndvi',
        status: 'partial',
        result: { mean_ndvi: 0.45, warning: 'High cloud cover detected' },
        evidence: { image: tile._id },
        confidence: 0.42,
        metadata: {}
      });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Calculate NDVI',
          imageRefs: [tile._id.toString()]
        });

      expect(res.status).toBe(200);
      assertValidResponseShape(res.body);
      expect(res.body.status).toBe('partial');
    });
  });

  describe('Out-of-scope queries', () => {
    test('returns valid shape for completely unrelated query', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'What is the weather forecast for tomorrow?',
          imageRefs: []
        });

      expect(res.status).toBe(200);
      assertValidResponseShape(res.body);
    });

    test('returns valid shape for non-geospatial query', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'How do I cook pasta?',
          imageRefs: []
        });

      expect(res.status).toBe(200);
      assertValidResponseShape(res.body);
    });
  });

  describe('Malformed requests', () => {
    test('returns valid shape when imageRefs is not an array', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Calculate NDVI',
          imageRefs: 'not-an-array'
        });

      expect(res.status).toBe(200);
      assertValidResponseShape(res.body);
    });

    test('returns valid shape when imageRefs contains invalid ObjectIds', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Calculate NDVI',
          imageRefs: ['invalid-id', 'also-invalid']
        });

      expect(res.status).toBe(200);
      assertValidResponseShape(res.body);
    });
  });

  describe('All error paths maintain schema compliance', () => {
    test('confidence is always between 0 and 1', async () => {
      const tile = await Tile.create({
        filename: 'test.tif',
        filePath: '/tmp/test.tif',
        format: 'geotiff',
        modality: 'sar'
      });

      mockCallMlService.mockResolvedValue({
        tool: 'ndvi',
        status: 'failed',
        result: {},
        evidence: {},
        confidence: 0,
        metadata: {}
      });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Calculate NDVI',
          imageRefs: [tile._id.toString()]
        });

      expect(res.body.confidence).toBeGreaterThanOrEqual(0);
      expect(res.body.confidence).toBeLessThanOrEqual(1);
    });

    test('executionTrace is always present and non-empty', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: '',
          imageRefs: []
        });

      expect(Array.isArray(res.body.executionTrace)).toBe(true);
      expect(res.body.executionTrace.length).toBeGreaterThan(0);
    });

    test('status is always one of the four valid values', async () => {
      const testCases = [
        { queryText: '', imageRefs: [] },
        { queryText: 'Calculate NDVI', imageRefs: ['invalid'] }
      ];

      for (const testCase of testCases) {
        const res = await request(app)
          .post('/api/query')
          .send(testCase);

        expect(['success', 'partial', 'failed', 'rejected']).toContain(res.body.status);
      }
    });
  });
});
