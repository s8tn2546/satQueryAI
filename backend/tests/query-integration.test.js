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
  mockCallMlService.mockResolvedValue({
    tool: 'ndvi',
    status: 'success',
    result: { mean_ndvi: 0.65, vegetation_coverage: 0.72 },
    evidence: { image: 'tile-1', region: {} },
    confidence: 0.88,
    metadata: {}
  });
});

describe('Query API Integration', () => {
  describe('Full /api/query round trip', () => {
    test('processes complete NDVI query successfully', async () => {
      const tile = await Tile.create({
        filename: 'test-ndvi.tif',
        filePath: '/tmp/test-ndvi.tif',
        format: 'geotiff',
        modality: 'optical'
      });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Calculate the vegetation index for this image',
          imageRefs: [tile._id.toString()]
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('answerText');
      expect(res.body).toHaveProperty('taskType', 'NDVI');
      expect(res.body).toHaveProperty('result');
      expect(res.body).toHaveProperty('evidence');
      expect(res.body).toHaveProperty('confidence');
      expect(res.body).toHaveProperty('executionTrace');
      expect(res.body).toHaveProperty('status');
      expect(['success', 'partial', 'failed', 'rejected']).toContain(res.body.status);
      expect(mockCallMlService).toHaveBeenCalledWith(
        expect.stringContaining('/ndvi'),
        expect.any(Object)
      );
    });

    test('processes CHANGE_ANALYSIS query with two images', async () => {
      const tile1 = await Tile.create({
        filename: 'before.tif',
        filePath: '/tmp/before.tif',
        format: 'geotiff',
        modality: 'optical',
        boundingBox: { coordinates: [[0, 0], [1, 1]] }
      });

      const tile2 = await Tile.create({
        filename: 'after.tif',
        filePath: '/tmp/after.tif',
        format: 'geotiff',
        modality: 'optical',
        boundingBox: { coordinates: [[0, 0], [1, 1]] }
      });

      mockCallMlService.mockResolvedValue({
        tool: 'change',
        status: 'success',
        result: { changed_pixels: 1024, change_percentage: 15.3 },
        evidence: { images: [tile1._id, tile2._id] },
        confidence: 0.85,
        metadata: {}
      });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'What has changed between these two images?',
          imageRefs: [tile1._id.toString(), tile2._id.toString()]
        });

      expect(res.status).toBe(200);
      expect(res.body.taskType).toBe('CHANGE_ANALYSIS');
      expect(res.body.status).toBe('success');
      expect(mockCallMlService).toHaveBeenCalled();
    });

    test('processes OPTICAL_SAR fusion query', async () => {
      const opticalTile = await Tile.create({
        filename: 'optical.tif',
        filePath: '/tmp/optical.tif',
        format: 'geotiff',
        modality: 'optical',
        boundingBox: { coordinates: [[0, 0], [1, 1]] }
      });

      const sarTile = await Tile.create({
        filename: 'sar.tif',
        filePath: '/tmp/sar.tif',
        format: 'geotiff',
        modality: 'sar',
        boundingBox: { coordinates: [[0, 0], [1, 1]] }
      });

      mockCallMlService.mockResolvedValue({
        tool: 'optical_sar',
        status: 'success',
        result: { built_up_area_km2: 12.5, water_area_km2: 3.2 },
        evidence: { images: [opticalTile._id, sarTile._id] },
        confidence: 0.79,
        metadata: {}
      });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Fuse optical and SAR to identify built-up areas',
          imageRefs: [opticalTile._id.toString(), sarTile._id.toString()]
        });

      expect(res.status).toBe(200);
      expect(res.body.taskType).toBe('OPTICAL_SAR');
      expect(res.body.status).toBe('success');
    });

    test('includes complete execution trace', async () => {
      const tile = await Tile.create({
        filename: 'test.tif',
        filePath: '/tmp/test.tif',
        format: 'geotiff',
        modality: 'optical'
      });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Calculate NDWI',
          imageRefs: [tile._id.toString()]
        });

      expect(res.status).toBe(200);
      expect(res.body.executionTrace).toBeDefined();
      expect(Array.isArray(res.body.executionTrace)).toBe(true);
      expect(res.body.executionTrace.length).toBeGreaterThan(0);
      
      const steps = res.body.executionTrace.map(e => e.step);
      expect(steps).toContain('intent_classification_start');
    });

    test('includes confidence score in response', async () => {
      const tile = await Tile.create({
        filename: 'test.tif',
        filePath: '/tmp/test.tif',
        format: 'geotiff',
        modality: 'optical'
      });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Calculate NDVI',
          imageRefs: [tile._id.toString()]
        });

      expect(res.status).toBe(200);
      expect(res.body.confidence).toBeDefined();
      expect(typeof res.body.confidence).toBe('number');
      expect(res.body.confidence).toBeGreaterThanOrEqual(0);
      expect(res.body.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('Error handling', () => {
    test('returns valid shape on ML service failure', async () => {
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
      expect(res.body.status).toBe('failed');
      expect(res.body).toHaveProperty('answerText');
      expect(res.body).toHaveProperty('confidence');
      expect(res.body).toHaveProperty('executionTrace');
    });

    test('returns rejected status for validation failures', async () => {
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
      expect(res.body.status).toBe('rejected');
      expect(res.body.answerText).toContain('optical');
    });

    test('handles missing images gracefully', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'Calculate NDVI',
          imageRefs: ['507f1f77bcf86cd799439011']
        });

      expect(res.status).toBe(200);
      expect(['rejected', 'failed']).toContain(res.body.status);
    });

    test('handles empty queryText', async () => {
      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: '',
          imageRefs: []
        });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('rejected');
    });
  });

  describe('Response format validation', () => {
    test('always returns Section 6 response shape', async () => {
      const tile = await Tile.create({
        filename: 'test.tif',
        filePath: '/tmp/test.tif',
        format: 'geotiff',
        modality: 'optical'
      });

      const res = await request(app)
        .post('/api/query')
        .send({
          queryText: 'What is this?',
          imageRefs: [tile._id.toString()]
        });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        answerText: expect.any(String),
        taskType: expect.any(String),
        result: expect.any(Object),
        evidence: expect.objectContaining({
          images: expect.any(Array),
          region: expect.any(Object)
        }),
        confidence: expect.any(Number),
        executionTrace: expect.any(Array),
        status: expect.stringMatching(/^(success|partial|failed|rejected)$/)
      });
    });
  });
});
