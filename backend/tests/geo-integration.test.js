import { jest } from '@jest/globals';

const mockCallMlService = jest.fn();

jest.unstable_mockModule('../src/services/mlServiceClient.js', () => ({
  default: { callMlService: mockCallMlService }
}));

const { MongoMemoryServer } = await import('mongodb-memory-server');
const mongoose = (await import('mongoose')).default;
const request = (await import('supertest')).default;
const { default: app } = await import('../src/index.js');
const { default: Tile } = await import('../src/models/Tile.js');

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  mockCallMlService.mockReset();
  await mongoose.connection.collection('tiles').deleteMany({});
});

const MOCK_BBOX = {
  type: 'Polygon',
  coordinates: [[[77.0, 28.0], [77.1, 28.0], [77.1, 28.1], [77.0, 28.1], [77.0, 28.0]]]
};

describe('§6.1a — Region-Based Image Acquisition + /validate integration', () => {

  describe('POST /api/images/fetch-by-region', () => {
    it('stores fetched images as tiles with source "gee-fetch"', async () => {
      mockCallMlService.mockResolvedValue({
        tool: 'fetch-imagery',
        status: 'success',
        result: {
          source: 'mock',
          images: [
            {
              modality: 'optical', source: 'sentinel-2', satellite: 'Sentinel-2',
              filePath: null, downloaded: false, captureDate: '2026-01-01T00:00:00Z',
              boundingBox: MOCK_BBOX, crs: 'EPSG:4326', resolution: 10,
              bands: ['B2', 'B3', 'B4', 'B8'], validated: false, validation_status: 'not-downloaded'
            },
            {
              modality: 'sar', source: 'sentinel-1', satellite: 'Sentinel-1',
              filePath: null, downloaded: false, captureDate: '2026-01-04T00:00:00Z',
              boundingBox: MOCK_BBOX, crs: 'EPSG:4326', resolution: 10,
              bands: ['VV', 'VH'], validated: false, validation_status: 'not-downloaded'
            }
          ],
          date_gap_days: 3,
          date_range: { start: '2025-12-01', end: '2026-01-01' },
          warnings: ['mock']
        },
        evidence: { region: MOCK_BBOX, data_source: 'mock' },
        confidence: 0.7,
        metadata: { data_source: 'mock' }
      });

      const res = await request(app)
        .post('/api/images/fetch-by-region')
        .send({ boundingBox: MOCK_BBOX, startDate: '2025-12-01', endDate: '2026-01-01' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.tileIds).toHaveLength(2);
      expect(mockCallMlService).toHaveBeenCalledWith('/fetch-imagery', {
        bounding_box: MOCK_BBOX,
        start_date: '2025-12-01',
        end_date: '2026-01-01'
      });

      const tiles = await Tile.find({ _id: { $in: res.body.tileIds } });
      expect(tiles).toHaveLength(2);
      for (const t of tiles) {
        expect(t.source).toBe('gee-fetch');
        expect(t.validationDetails.source).toBe('gee-fetch');
      }
      const optical = tiles.find(t => t.modality === 'optical');
      const sar = tiles.find(t => t.modality === 'sar');
      expect(optical).toBeTruthy();
      expect(sar).toBeTruthy();
      expect(optical.bands).toEqual(['B2', 'B3', 'B4', 'B8']);
      expect(sar.bands).toEqual(['VV', 'VH']);
    });

    it('produces the same response shape as upload (tileId + tileIds + tiles)', async () => {
      mockCallMlService.mockResolvedValue({
        tool: 'fetch-imagery', status: 'success', confidence: 0.7,
        result: {
          source: 'mock',
          images: [{ modality: 'optical', source: 'sentinel-2', filePath: null, bands: [] }]
        },
        metadata: { data_source: 'mock' }
      });

      const res = await request(app)
        .post('/api/images/fetch-by-region')
        .send({ boundingBox: MOCK_BBOX });

      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('tileId');
      expect(res.body).toHaveProperty('tileIds');
      expect(res.body).toHaveProperty('tiles');
      expect(res.body).toHaveProperty('validationResult');
      expect(Array.isArray(res.body.tileIds)).toBe(true);
    });

    it('returns failed status when ML fetch-imagery fails', async () => {
      mockCallMlService.mockResolvedValue({
        tool: 'fetch-imagery', status: 'failed', confidence: 0.0,
        result: { error: 'Imagery acquisition could not use real GEE data: no creds' }
      });

      const res = await request(app)
        .post('/api/images/fetch-by-region')
        .send({ boundingBox: MOCK_BBOX });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.tileIds).toEqual([]);
    });

    it('rejects when boundingBox is missing', async () => {
      const res = await request(app)
        .post('/api/images/fetch-by-region')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('rejected');
    });
  });

  describe('POST /api/images/upload — /validate integration', () => {
    it('calls /validate and stores the ML verdict on the tile', async () => {
      mockCallMlService.mockResolvedValue({
        tool: 'validate', status: 'success', confidence: 0.9,
        result: { valid: true, validation_status: 'valid', errors: [], warnings: [] },
        evidence: { filename: 'test.tif' }
      });

      const buffer = Buffer.from('fake-tiff-content');

      const res = await request(app)
        .post('/api/images/upload')
        .field('modality', 'optical')
        .attach('images', buffer, 'test.tif');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(mockCallMlService).toHaveBeenCalledWith(
        '/validate',
        expect.objectContaining({ format: 'tiff', modality_hint: 'optical' })
      );

      const tile = await Tile.findById(res.body.tileId);
      expect(tile).toBeTruthy();
      expect(tile.validated).toBe(true);
      expect(tile.validationDetails.validationSource).toBe('ml-service');
      expect(tile.validationDetails.validationStatus).toBe('valid');
    });

    it('falls back to local validation when the ML service is unreachable', async () => {
      mockCallMlService.mockRejectedValue(new Error('ECONNREFUSED'));

      const res = await request(app)
        .post('/api/images/upload')
        .field('modality', 'optical')
        .attach('images', Buffer.from('png-bytes'), 'test.png');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      const tile = await Tile.findById(res.body.tileId);
      expect(tile.validated).toBe(true);
      expect(tile.validationDetails.validationSource).toBe('local-fallback');
    });
  });
});
