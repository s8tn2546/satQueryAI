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
const { seedTools } = await import('../src/services/seedTools.js');

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

  describe('fetch-by-region boundingBox normalization', () => {
    function mockEcho(bbox) {
      mockCallMlService.mockResolvedValue({
        tool: 'fetch-imagery',
        status: 'success',
        result: {
          source: 'mock',
          images: [
            { modality: 'optical', source: 'sentinel-2', filePath: null, downloaded: false, boundingBox: bbox },
            { modality: 'sar', source: 'sentinel-1', filePath: null, downloaded: false, boundingBox: bbox }
          ]
        },
        metadata: { data_source: 'mock', mock: true }
      });
    }

    it('normalizes a compact [x1,y1,x2,y2] request bbox to a canonical Polygon before forwarding and persisting', async () => {
      const compact = [77.0, 28.0, 77.1, 28.1];
      const expectedPolygon = {
        type: 'Polygon',
        coordinates: [[
          [77.0, 28.0], [77.1, 28.0], [77.1, 28.1], [77.0, 28.1], [77.0, 28.0]
        ]]
      };
      mockEcho(compact);

      const res = await request(app)
        .post('/api/images/fetch-by-region')
        .send({ boundingBox: compact });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(mockCallMlService).toHaveBeenCalledWith(
        '/fetch-imagery',
        expect.objectContaining({ bounding_box: expectedPolygon })
      );

      const tiles = await Tile.find({ _id: { $in: res.body.tileIds } });
      for (const t of tiles) {
        expect(JSON.parse(JSON.stringify(t.boundingBox))).toEqual(expectedPolygon);
      }
    });

    it('normalizes a bounds-object ({west,south,east,north}) mock echo before persistence', async () => {
      const bounds = { west: 77.0, south: 28.0, east: 77.1, north: 28.1 };
      const expectedPolygon = {
        type: 'Polygon',
        coordinates: [[
          [77.0, 28.0], [77.1, 28.0], [77.1, 28.1], [77.0, 28.1], [77.0, 28.0]
        ]]
      };
      mockEcho(bounds);

      const res = await request(app)
        .post('/api/images/fetch-by-region')
        .send({ boundingBox: MOCK_BBOX });

      expect(res.status).toBe(200);
      const tiles = await Tile.find({ _id: { $in: res.body.tileIds } });
      for (const t of tiles) {
        expect(JSON.parse(JSON.stringify(t.boundingBox))).toEqual(expectedPolygon);
      }
    });

    it('normalizes a snake_case per-image bounding_box (real ML summary shape)', async () => {
      const snakeBbox = { type: 'Polygon', coordinates: [[[77.0, 28.0], [77.1, 28.0], [77.1, 28.1], [77.0, 28.1], [77.0, 28.0]]] };
      mockCallMlService.mockResolvedValue({
        tool: 'fetch-imagery',
        status: 'success',
        result: {
          source: 'gee',
          images: [
            { modality: 'optical', source: 'sentinel-2', filePath: '/tmp/real.tif', downloaded: true, bounding_box: snakeBbox }
          ]
        },
        metadata: { data_source: 'gee' }
      });

      const res = await request(app)
        .post('/api/images/fetch-by-region')
        .send({ boundingBox: MOCK_BBOX });

      expect(res.status).toBe(200);
      const tiles = await Tile.find({ _id: { $in: res.body.tileIds } });
      expect(JSON.parse(JSON.stringify(tiles[0].boundingBox))).toEqual(snakeBbox);
      expect(tiles[0].validationDetails.downloaded).toBe(true);
    });

    it('falls back to the canonical request bbox when an image has no usable boundingBox', async () => {
      mockCallMlService.mockResolvedValue({
        tool: 'fetch-imagery',
        status: 'success',
        result: {
          source: 'mock',
          images: [{ modality: 'optical', filePath: null, bands: [] }]
        },
        metadata: { data_source: 'mock', mock: true }
      });

      const res = await request(app)
        .post('/api/images/fetch-by-region')
        .send({ boundingBox: MOCK_BBOX });

      expect(res.status).toBe(200);
      const tiles = await Tile.find({ _id: { $in: res.body.tileIds } });
      expect(JSON.parse(JSON.stringify(tiles[0].boundingBox))).toEqual(MOCK_BBOX);
    });

    it.each([
      ['Point geometry', { type: 'Point', coordinates: [77.0, 28.0] }],
      ['string', '77.0,28.0,77.1,28.1'],
      ['too-short array', [77.0, 28.0]],
      ['empty polygon', { type: 'Polygon', coordinates: [] }],
      ['non-finite coordinates', [77.0, 'x', 77.1, 28.1]]
    ])('rejects invalid boundingBox: %s (no 500, nothing persisted)', async (_label, bad) => {
      mockCallMlService.mockResolvedValue({
        tool: 'fetch-imagery',
        status: 'success',
        result: { images: [] }
      });

      const res = await request(app)
        .post('/api/images/fetch-by-region')
        .send({ boundingBox: bad });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('rejected');
      expect(mockCallMlService).not.toHaveBeenCalled();
      expect(await Tile.countDocuments()).toBe(0);
    });
  });
});

// =============================================================================
// Drawn AOI end-to-end: query request -> validation -> ML call -> response
// =============================================================================

describe('Drawn AOI end-to-end', () => {
  const DRAWN_AOI = {
    type: 'Polygon',
    coordinates: [[[77.0, 28.0], [77.1, 28.0], [77.1, 28.1], [77.0, 28.1], [77.0, 28.0]]]
  };

  async function seedOpticalTile() {
    return Tile.create({
      source: 'benchmark-upload',
      modality: 'optical',
      format: 'geotiff',
      filePath: '/real/uploads/scene.tif',
      crs: 'EPSG:32643',
      boundingBox: MOCK_BBOX,
      captureDate: new Date('2025-01-01')
    });
  }

  it('carries the drawn AOI from the request all the way into the ML call', async () => {
    const tile = await seedOpticalTile();
    mockCallMlService.mockResolvedValue({
      tool: 'ndvi',
      status: 'success',
      result: {
        mean: 0.61,
        valid_pixel_count: 144,
        aoi: {
          aoiPresent: true, aoiApplied: true, aoiScope: 'raster_window+mask',
          aoiStatus: 'applied', aoiCrs: 'EPSG:4326', aoiCrsSource: 'rfc7946_default',
          aoiMaskedPixels: 144, isGeoreferenced: true
        }
      },
      confidence: 0.9
    });

    const res = await request(app).post('/api/query').send({
      queryText: 'What is the NDVI of this image?',
      imageRefs: [String(tile._id)],
      parameters: { aoi: DRAWN_AOI }
    });
    expect(res.status).toBe(200);
    expect(res.body.status).not.toBe('rejected');

    // The ML service really received the drawn geometry.
    const [endpoint, payload] = mockCallMlService.mock.calls[0];
    expect(endpoint).toBe('/ndvi');
    expect(payload.aoi_geometry).toEqual(DRAWN_AOI);
    expect(payload.aoi_requested).toBe(true);

    // The trace explains the scope decision before the tool ever runs.
    const steps = res.body.executionTrace.map(t => t.step);
    expect(steps).toContain('aoi_validation');
    expect(steps.indexOf('aoi_validation')).toBeGreaterThan(steps.indexOf('input_validation'));
    expect(res.body.executionTrace.find(t => t.step === 'aoi_application').details)
      .toContain('AOI applied by ML service');
  });

  it('rejects a structurally broken AOI before any ML call is made', async () => {
    const tile = await seedOpticalTile();

    const res = await request(app).post('/api/query').send({
      queryText: 'Compute NDVI in the area I selected',
      imageRefs: [String(tile._id)],
      parameters: { aoi: { type: 'Point', coordinates: [77.05, 28.05] } }
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.answerText || res.body.answer).toMatch(/not supported/);
    expect(mockCallMlService).not.toHaveBeenCalled();
  });

  it('an AOI that misses the raster fails loudly instead of returning a whole-scene number', async () => {
    const tile = await seedOpticalTile();
    // The ML service is authoritative: it opens the pixels and refuses.
    mockCallMlService.mockResolvedValue({
      tool: 'ndvi',
      status: 'failed',
      result: { error: 'AOI does not intersect the raster footprint.' },
      metadata: {
        aoi: {
          aoiPresent: true, aoiApplied: false, aoiScope: null,
          aoiStatus: 'rejected_outside_raster', isGeoreferenced: true
        }
      },
      confidence: 0
    });

    const res = await request(app).post('/api/query').send({
      queryText: 'Compute NDVI in the area I selected',
      imageRefs: [String(tile._id)],
      parameters: { aoi: DRAWN_AOI }
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.toolResults[0].status).toBe('failed');
    expect(res.body.toolResults[0].error).toMatch(/does not intersect/);
    expect(res.body.executionTrace.find(t => t.step === 'aoi_application').details)
      .toContain('AOI was NOT applied by ML service');
  });
});
