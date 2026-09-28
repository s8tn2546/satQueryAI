import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
let previewPng;
let analysisTif;

const AOI = {
  type: 'Polygon',
  coordinates: [[[30.0, 60.0], [30.5, 60.0], [30.5, 60.5], [30.0, 60.5], [30.0, 60.0]]]
};

const WGS84_BOUNDS = {
  west: 30.0, south: 60.0, east: 30.5, north: 60.5
};

function baseIngestResult({ platform = 'landsat-9', collection = 'landsat-c2-l2', sceneId = 'LC09_TEST' } = {}) {
  return {
    tool: 'stac-ingest',
    status: 'success',
    confidence: 0.7,
    metadata: {
      provider: { name: 'stac-fixture', mode: 'test' },
      mock: true,
      reason: 'deterministic fixture',
      source_warning: 'Mock/fixture data',
      warnings: [],
      validation: { status: 'georeferenced_analysis_ready', integrity: null }
    },
    result: {
      source: 'stac-fixture',
      provider: 'stac-fixture',
      collection,
      collectionName: 'Landsat Collection 2 Level-2 (surface reflectance)',
      sceneId,
      scene: {
        sceneId,
        collection,
        provider: 'stac-fixture',
        platform,
        instrument: 'landsat',
        datetime: '2025-03-02T05:10:42Z',
        cloudCover: 2.0,
        mock: true,
        reason: 'deterministic fixture',
        summary: () => ({ sceneId })
      },
      aoi: { geometry: AOI, crs: 'EPSG:4326', crsSource: 'EPSG:4326', bounds: WGS84_BOUNDS, warnings: [] },
      analysisRaster: analysisTif,
      analysis: {
        roles: ['blue', 'green', 'red', 'nir'],
        bands: ['blue', 'green', 'red', 'nir08'],
        width: 16,
        height: 16,
        crs: 'EPSG:32643',
        resolution: { x: 30, y: 30 },
        nativeBounds: { west: 500000, south: 4599500, east: 500480, north: 4600000 },
        wgs84Bounds: WGS84_BOUNDS,
        method: 'fixture-cog-window-read',
        scope: 'cog-window-read',
        bandDescriptions: ['blue', 'green', 'red', 'nir08']
      },
      preview: {
        filePath: previewPng,
        channels: ['red', 'green', 'blue'],
        stretch: 'percentile-2-98'
      },
      validation: {
        valid: true,
        status: 'georeferenced_analysis_ready',
        integrity: 'ok',
        modality: 'optical',
        isGeoreferenced: true,
        errors: [],
        warnings: []
      },
      dedupeKey: `stac:stac-fixture:${collection}:${sceneId}:aoi:blue,green,nir,red:EPSG:32643`,
      mock: true,
      reason: 'deterministic fixture',
      warnings: [],
      labels: { name: 'stac-fixture', mode: 'test' }
    }
  };
}

function baseSearchResult({ collection = 'sentinel-2-l2a', count = 2 } = {}) {
  return {
    tool: 'stac-search',
    status: 'success',
    confidence: 0.7,
    metadata: {
      provider: { name: 'stac-fixture', mode: 'test' },
      mock: true,
      reason: 'deterministic fixture',
      source_warning: 'Mock/fixture data',
      warnings: []
    },
    result: {
      source: 'stac-fixture',
      provider: 'stac-fixture',
      collection,
      collectionName: 'Sentinel-2 MSI L2A (surface reflectance)',
      resolution: 10,
      query: { dateRange: { start: '2025-01-01', end: '2025-12-31' }, aoiCrs: 'EPSG:4326' },
      count,
      mock: true,
      reason: 'deterministic fixture',
      warnings: [],
      labels: { name: 'stac-fixture', mode: 'test' },
      scenes: Array.from({ length: count }, (_, i) => ({
        sceneId: `fixture-s2a-202503${String(i + 1).padStart(2, '0')}`,
        collection,
        provider: 'stac-fixture',
        platform: 'sentinel-2a',
        datetime: '2025-03-01T04:21:03Z',
        cloudCover: 5 + i * 7,
        mock: true,
        reason: 'deterministic fixture'
      }))
    }
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stac-preview-'));
  previewPng = path.join(tmp, 'preview.png');
  // 1x1 red pixel PNG.
  fs.writeFileSync(previewPng, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  ));
  // A stand-in analysis raster (route only checks existence + format).
  analysisTif = path.join(tmp, 'analysis.tif');
  fs.writeFileSync(analysisTif, Buffer.from('dummy-geotiff-payload'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  if (previewPng) fs.rmSync(path.dirname(previewPng), { recursive: true, force: true });
});

afterEach(async () => {
  mockCallMlService.mockReset();
  await mongoose.connection.collection('tiles').deleteMany({});
});

describe('POST /api/stac/search', () => {
  it('rejects a request without an AOI', async () => {
    const res = await request(app).post('/api/stac/search').send({ sensor: 'sentinel-2' });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.error).toMatch(/aoi/i);
  });

  it('rejects a request without a full date range', async () => {
    const res = await request(app).post('/api/stac/search').send({
      sensor: 'sentinel-2',
      dateRange: { start: '2025-01-01' },
      aoi: AOI
    });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('proxies a successful search and maps scene fields', async () => {
    mockCallMlService.mockResolvedValue(baseSearchResult({ count: 2 }));
    const res = await request(app).post('/api/stac/search').send({
      sensor: 'sentinel-2',
      dateRange: { start: '2025-01-01', end: '2025-12-31' },
      aoi: AOI,
      cloudMax: 50
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.collection).toBe('sentinel-2-l2a');
    expect(res.body.count).toBe(2);
    expect(res.body.scenes).toHaveLength(2);
    expect(res.body.scenes[0].sceneId).toBe('fixture-s2a-20250301');
    expect(res.body.mock).toBe(true);
    expect(res.body.reason).toBeTruthy();
    expect(res.body.confidence).toBe(0.7);
    expect(res.body.metadata.mock).toBe(true);
    expect(mockCallMlService).toHaveBeenCalledWith(
      '/stac/search',
      expect.objectContaining({ aoi: AOI, dateRange: { start: '2025-01-01', end: '2025-12-31' }, cloudMax: 50 })
    );
  });

  it('returns failed with the ML error when the service reports failure', async () => {
    mockCallMlService.mockResolvedValue({
      tool: 'stac-search',
      status: 'failed',
      confidence: 0,
      result: { error: 'No live satellite provider is configured.' },
      metadata: {}
    });
    const res = await request(app).post('/api/stac/search').send({
      sensor: 'sentinel-2',
      dateRange: { start: '2025-01-01', end: '2025-02-01' },
      aoi: AOI
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.error).toMatch(/No live satellite provider/);
    expect(res.body.scenes).toEqual([]);
    expect(res.body.count).toBe(0);
  });
});

describe('POST /api/stac/ingest', () => {
  it('rejects a request missing collection/sceneId/aoi', async () => {
    const missingCases = [{}, { sceneId: 'x', aoi: AOI }, { collection: 'sentinel-2-l2a', aoi: AOI }];
    for (const body of missingCases) {
      const res = await request(app).post('/api/stac/ingest').send(body);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    }
  });

  it('persists a tile with full STAC provenance and preview', async () => {
    mockCallMlService.mockResolvedValue(baseIngestResult());
    const res = await request(app).post('/api/stac/ingest').send({
      collection: 'landsat-c2-l2',
      sceneId: 'LC09_TEST',
      aoi: AOI
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.duplicate).toBe(false);
    expect(res.body.tileId).toBeTruthy();

    const tile = await Tile.findById(res.body.tileId);
    expect(tile).not.toBeNull();
    expect(tile.source).toBe('landsat-9');
    expect(tile.modality).toBe('optical');
    expect(tile.format).toBe('geotiff');
    expect(tile.provider).toBe('stac-fixture');
    expect(tile.sceneId).toBe('LC09_TEST');
    expect(tile.collection).toBe('landsat-c2-l2');
    expect(tile.dedupeKey).toContain('stac:stac-fixture:landsat-c2-l2:LC09_TEST');
    expect(tile.analysisRaster).not.toBeNull();
    expect(tile.bands).toEqual(['blue', 'green', 'red', 'nir08']);
    expect(tile.crs).toBe('EPSG:32643');
    expect(tile.resolution).toBe(30);
    expect(tile.validated).toBe(true);
    expect(tile.aoi).toEqual(AOI);
    expect(tile.aoiCrs).toBe('EPSG:4326');
    expect(tile.previews.png).toBe(previewPng);
    expect(tile.previews.channels).toEqual(['red', 'green', 'blue']);
    expect(tile.boundingBox.type).toBe('Polygon');
    // Evidence view: renderable via the preview even though the source is TIFF.
    expect(res.body.tiles[0].renderable).toBe(true);
    expect(res.body.tiles[0].hasPreview).toBe(true);
    expect(res.body.validationResult.valid).toBe(true);
  });

  it('derives sentinel-2 source for sentinel platforms', async () => {
    mockCallMlService.mockResolvedValue(baseIngestResult({
      platform: 'sentinel-2a',
      collection: 'sentinel-2-l2a',
      sceneId: 'S2A_TEST'
    }));
    const res = await request(app).post('/api/stac/ingest').send({
      collection: 'sentinel-2-l2a',
      sceneId: 'S2A_TEST',
      aoi: AOI
    });
    const tile = await Tile.findById(res.body.tileId);
    expect(tile.source).toBe('sentinel-2');
    expect(tile.dedupeKey).toContain('sentinel-2-l2a');
  });

  it('dedupes identical acquisitions and returns the existing tile', async () => {
    mockCallMlService.mockResolvedValue(baseIngestResult());
    const body = { collection: 'landsat-c2-l2', sceneId: 'LC09_TEST', aoi: AOI };
    const first = await request(app).post('/api/stac/ingest').send(body);
    expect(first.body.duplicate).toBe(false);
    const second = await request(app).post('/api/stac/ingest').send(body);
    expect(second.body.status).toBe('success');
    expect(second.body.duplicate).toBe(true);
    expect(second.body.tileId).toBe(first.body.tileId);
    await expect(Tile.countDocuments({})).resolves.toBe(1);
  });

  it('rejects an unknown platform with 422 and persists nothing', async () => {
    mockCallMlService.mockResolvedValue(baseIngestResult({ platform: 'modis', sceneId: 'UNKNOWN' }));
    const res = await request(app).post('/api/stac/ingest').send({
      collection: 'landsat-c2-l2',
      sceneId: 'UNKNOWN',
      aoi: AOI
    });
    expect(res.status).toBe(422);
    expect(res.body.status).toBe('failed');
    expect(res.body.error).toMatch(/unknown platform/i);
    await expect(Tile.countDocuments({})).resolves.toBe(0);
  });

  it('returns failed and persists nothing when the ML service reports failure', async () => {
    mockCallMlService.mockResolvedValue({
      tool: 'stac-ingest',
      status: 'failed',
      confidence: 0,
      result: { error: 'Scene fetching failed: no intersection' },
      metadata: {}
    });
    const res = await request(app).post('/api/stac/ingest').send({
      collection: 'sentinel-2-l2a',
      sceneId: 'S2A_TEST',
      aoi: AOI
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.error).toMatch(/no intersection/i);
    expect(res.body.tileId).toBeNull();
    await expect(Tile.countDocuments({})).resolves.toBe(0);
  });
});

describe('Preview serving for STAC tiles', () => {
  it('GET /api/tiles/:id/preview serves the stored preview PNG', async () => {
    mockCallMlService.mockResolvedValue(baseIngestResult());
    const ingest = await request(app).post('/api/stac/ingest').send({
      collection: 'landsat-c2-l2',
      sceneId: 'LC09_TEST',
      aoi: AOI
    });
    const res = await request(app).get(`/api/tiles/${ingest.body.tileId}/preview`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });

  it('GET /api/tiles/:id/image serves preview bytes for a geotiff without a browser-renderable source', async () => {
    mockCallMlService.mockResolvedValue(baseIngestResult());
    const ingest = await request(app).post('/api/stac/ingest').send({
      collection: 'landsat-c2-l2',
      sceneId: 'LC09_TEST',
      aoi: AOI
    });
    const res = await request(app).get(`/api/tiles/${ingest.body.tileId}/image`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });
});