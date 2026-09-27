import { jest } from '@jest/globals';

// =============================================================================
// AOI propagation through the backend executor
//
// Verifies that a drawn AOI actually reaches the ML service, that its CRS is
// forwarded when known (and never invented), and that the execution trace
// reports what the ML service really did with the AOI instead of assuming
// the scope was honored just because a request was sent.
// =============================================================================

const mockCallMlService = jest.fn();

jest.unstable_mockModule('../src/services/mlServiceClient.js', () => ({
  default: { callMlService: mockCallMlService }
}));

const { MongoMemoryServer } = await import('mongodb-memory-server');
const mongoose = (await import('mongoose')).default;
const { default: Tile } = await import('../src/models/Tile.js');
const { seedTools } = await import('../src/services/seedTools.js');
const { planTools } = await import('../src/agents/taskPlanner.js');
const { executeTools } = await import('../src/agents/toolExecutor.js');

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

afterEach(() => {
  mockCallMlService.mockReset();
});

const AOI = {
  type: 'Polygon',
  coordinates: [[[72.0, 18.0], [72.5, 18.0], [72.5, 18.5], [72.0, 18.5], [72.0, 18.0]]]
};

async function makeTile(overrides = {}) {
  return Tile.create({
    source: 'benchmark-upload',
    modality: 'optical',
    format: 'geotiff',
    filePath: '/real/uploads/a.tif',
    crs: 'EPSG:32643',
    captureDate: new Date('2025-01-01'),
    ...overrides
  });
}

function appliedReport(overrides = {}) {
  return {
    aoiPresent: true,
    aoiApplied: true,
    aoiScope: 'raster_window+mask',
    aoiStatus: 'applied',
    aoiMaskedPixels: 36,
    ...overrides
  };
}

function success(endpoint, result) {
  return { tool: endpoint.replace('/', ''), status: 'success', result, confidence: 0.8 };
}

describe('AOI payload propagation', () => {
  test('sends aoi_geometry when parameters.aoi is set', async () => {
    const tools = await planTools('NDVI', ['ndvi'], []);
    const tiles = [await makeTile()];
    mockCallMlService.mockResolvedValue(success('/ndvi', { mean: 0.5, aoi: appliedReport() }));

    await executeTools(tools, tiles, { aoi: AOI }, []);

    const [endpoint, payload] = mockCallMlService.mock.calls[0];
    expect(endpoint).toBe('/ndvi');
    expect(payload.aoi_geometry).toEqual(AOI);
    expect(payload.aoi_requested).toBe(true);
  });

  test('forwards an explicit aoiCrs to the ML service', async () => {
    const tools = await planTools('NDVI', ['ndvi'], []);
    const tiles = [await makeTile()];
    mockCallMlService.mockResolvedValue(success('/ndvi', { mean: 0.5, aoi: appliedReport() }));

    await executeTools(tools, tiles, { aoi: AOI, aoiCrs: 'EPSG:32643' }, []);

    expect(mockCallMlService.mock.calls[0][1].aoi_crs).toBe('EPSG:32643');
  });

  test('never invents a CRS when the user did not state one', async () => {
    const tools = await planTools('NDVI', ['ndvi'], []);
    const tiles = [await makeTile()];
    mockCallMlService.mockResolvedValue(success('/ndvi', { mean: 0.5, aoi: appliedReport() }));

    await executeTools(tools, tiles, { aoi: AOI }, []);

    // ML assumes RFC 7946 (EPSG:4326) for bare GeoJSON; the backend must not
    // send the raster's CRS as if the AOI had been declared in it.
    expect(mockCallMlService.mock.calls[0][1].aoi_crs).toBeUndefined();
  });

  test('marks aoi_requested=false and omits aoi_geometry when no AOI is drawn', async () => {
    const tools = await planTools('NDVI', ['ndvi'], []);
    const tiles = [await makeTile()];
    mockCallMlService.mockResolvedValue(success('/ndvi', { mean: 0.5, aoi: { aoiPresent: false, aoiApplied: false } }));

    await executeTools(tools, tiles, { featureType: 'x' }, []);

    const payload = mockCallMlService.mock.calls[0][1];
    expect(payload.aoi_requested).toBe(false);
    expect(payload.aoi_geometry).toBeUndefined();
  });

  test('every tool in a multi-tool plan receives the AOI', async () => {
    const tools = await planTools('CHANGE_ANALYSIS', ['ndvi', 'change'], []);
    const tiles = [await makeTile(), await makeTile({ captureDate: new Date('2025-06-01') })];
    mockCallMlService.mockImplementation(async (endpoint) => success(endpoint, { aoi: appliedReport() }));

    await executeTools(tools, tiles, { aoi: AOI, aoiCrs: 'EPSG:32643' }, []);

    expect(mockCallMlService.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [, payload] of mockCallMlService.mock.calls) {
      expect(payload.aoi_geometry).toEqual(AOI);
      expect(payload.aoi_crs).toBe('EPSG:32643');
    }
  });
});

describe('AOI outcome is reported, not assumed', () => {
  test('records that the ML service applied the AOI', async () => {
    const tools = await planTools('NDVI', ['ndvi'], []);
    const tiles = [await makeTile()];
    const trace = [];
    mockCallMlService.mockResolvedValue(success('/ndvi', { mean: 0.5, aoi: appliedReport() }));

    await executeTools(tools, tiles, { aoi: AOI }, trace);

    const entry = trace.find(t => t.step === 'aoi_application');
    expect(entry).toBeDefined();
    expect(entry.details).toContain('AOI applied by ML service');
    expect(entry.details).toContain('raster_window+mask');
  });

  test('records a window-only scope honestly', async () => {
    const tools = await planTools('VQA', ['vqa'], []);
    const tiles = [await makeTile()];
    const trace = [];
    mockCallMlService.mockResolvedValue(success('/vqa', {
      answer: 'water',
      aoi: { aoiPresent: true, aoiApplied: true, aoiScope: 'raster_window', aoiStatus: 'applied' }
    }));

    await executeTools(tools, tiles, { aoi: AOI, question: 'water?' }, trace);

    const entry = trace.find(t => t.step === 'aoi_application');
    expect(entry.details).toContain('raster_window');
  });

  test('records a NOT-applied outcome instead of claiming a scoped result', async () => {
    const tools = await planTools('NDVI', ['ndvi'], []);
    const tiles = [await makeTile()];
    const trace = [];
    mockCallMlService.mockResolvedValue({
      tool: 'ndvi',
      status: 'failed',
      result: { error: 'AOI does not intersect raster' },
      metadata: { aoi: { aoiPresent: true, aoiApplied: false, aoiStatus: 'rejected_outside_raster' } },
      confidence: 0
    });

    await executeTools(tools, tiles, { aoi: AOI }, trace);

    const entry = trace.find(t => t.step === 'aoi_application');
    expect(entry.details).toContain('AOI was NOT applied by ML service');
    expect(entry.details).toContain('rejected_outside_raster');
  });

  test('flags a missing AOI report as unverified rather than assuming success', async () => {
    const tools = await planTools('NDVI', ['ndvi'], []);
    const tiles = [await makeTile()];
    const trace = [];
    // A tool that silently ignores the AOI: no report at all.
    mockCallMlService.mockResolvedValue(success('/ndvi', { mean: 0.5 }));

    await executeTools(tools, tiles, { aoi: AOI }, trace);

    const entry = trace.find(t => t.step === 'aoi_application');
    expect(entry.details).toContain('unverified');
  });

  test('labels an unscoped run as full-scene', async () => {
    const tools = await planTools('NDVI', ['ndvi'], []);
    const tiles = [await makeTile()];
    const trace = [];
    mockCallMlService.mockResolvedValue(success('/ndvi', { mean: 0.5 }));

    await executeTools(tools, tiles, {}, trace);

    const entry = trace.find(t => t.step === 'aoi_application');
    expect(entry.details).toContain('no AOI requested');
    expect(entry.details).toContain('unscoped');
  });

  test('reports the AOI outcome when the ML call throws', async () => {
    const tools = await planTools('NDVI', ['ndvi'], []);
    const tiles = [await makeTile()];
    const trace = [];
    mockCallMlService.mockRejectedValue(new Error('ECONNREFUSED'));

    const results = await executeTools(tools, tiles, { aoi: AOI }, trace);

    expect(results[0].status).toBe('failed');
    expect(trace.find(t => t.step === 'aoi_application').details).toContain('unverified');
  });

  test('a derived area from change states the AOI was inherited, not measured', async () => {
    const tools = await planTools('CHANGE_ANALYSIS', ['change', 'area'], []);
    const tiles = [await makeTile(), await makeTile({ captureDate: new Date('2025-06-01') })];
    const trace = [];
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/change') {
        return success('/change', { changed_area_km2: 3.2, aoi: appliedReport() });
      }
      return success('/area', {});
    });

    const results = await executeTools(tools, tiles, { aoi: AOI }, trace);

    const areaEntry = results.find(r => r.tool === 'area');
    expect(areaEntry.status).toBe('success');
    const traceEntry = trace.filter(t => t.step === 'aoi_application' && t.details.includes('"area"')).pop();
    expect(traceEntry.details).toContain('inherited from the change result');
    expect(traceEntry.details).toContain('no separate /area measurement');
  });
});
