import { jest } from '@jest/globals';

// =============================================================================
// Agent Milestone 2 — Dependency-Aware Execution & Output Chaining
//
// Verifies that the Agent actually EXECUTES dependency-aware multi-tool plans
// (the M1 plan is no longer metadata-only):
//  1. Single-tool queries still work
//  2. Independent multi-tool queries execute independently
//  3. fetch-imagery -> ndvi only injects the fetched raster when one actually
//     exists (real, downloaded file), never a mock placeholder
//  4. fetch-imagery failure -> ndvi is SKIPPED, never run on unrelated tiles
//  5. change -> area derives the changed area from change.changed_area_km2 when
//     available; otherwise attaches change context (no fabricated raster)
//  6. Independent tool failures do not block unrelated tools
//  7. Dependency-failure propagation is deterministic and skips dependents
//  8. Dependency outputs never leak into unrelated tool payloads (isolation)
//  9. Original tiles + parameters are never mutated
// 10. Dependency behavior is surfaced in trace + persisted Query
// =============================================================================

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
const { planTools } = await import('../src/agents/taskPlanner.js');
const { executeTools } = await import('../src/agents/toolExecutor.js');

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
    filePath: '/tmp/uploaded-original.png',
    validated: true,
    validationDetails: {},
    ...overrides
  });
}

/** Capture every (endpoint, payload) passed to the ML client. */
function captureCalls() {
  const calls = [];
  mockCallMlService.mockImplementation(async (endpoint, payload) => {
    calls.push({ endpoint, payload: JSON.parse(JSON.stringify(payload)) });
    if (endpoint.endsWith('/fetch-imagery')) {
      const mocked = mockCallMlService.__fetchResult;
      return mocked || { tool: 'fetch-imagery', status: 'success', result: { images: [], source: 'mock' }, confidence: 0.7 };
    }
    if (endpoint.endsWith('/ndvi')) return { tool: 'ndvi', status: 'success', result: { value: 0.5 }, confidence: 0.9 };
    if (endpoint.endsWith('/ndwi')) return { tool: 'ndwi', status: 'success', result: { value: 0.4 }, confidence: 0.9 };
    if (endpoint.endsWith('/change')) return { tool: 'change', status: 'success', result: { change_percentage: 8.4 }, confidence: 0.9 };
    if (endpoint.endsWith('/area')) return { tool: 'area', status: 'success', result: { area_km2: 12.3 }, confidence: 0.9 };
    return { tool: 'unknown', status: 'success', result: { ok: true }, confidence: 0.5 };
  });
  return calls;
}

// ---------------------------------------------------------------------------
// 1. Single tool still works
// ---------------------------------------------------------------------------
describe('M2 — single-tool backward compatibility', () => {
  test('standalone NDVI still executes end-to-end', async () => {
    const calls = captureCalls();
    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'calculate NDVI', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.toolResults.map(t => t.tool)).toEqual(['ndvi']);
    expect(calls.map(c => c.endpoint)).toEqual(['/ndvi']);
  });

  test('standalone AREA (no dependency) still executes on the original tile', async () => {
    const calls = captureCalls();
    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'calculate the surface area', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.toolResults.map(t => t.tool)).toEqual(['area']);
    const areaCall = calls.find(c => c.endpoint === '/area');
    expect(areaCall.payload.image_path).toBe('/tmp/uploaded-original.png');
    expect(areaCall.payload.change_context).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Independent multi-tool queries
// ---------------------------------------------------------------------------
describe('M2 — independent multi-tool execution', () => {
  test('"calculate NDVI and NDWI" executes BOTH tools independently', async () => {
    const calls = captureCalls();
    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'calculate NDVI and NDWI', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.toolResults.map(t => t.tool)).toEqual(['ndvi', 'ndwi']);
    expect(calls.map(c => c.endpoint)).toEqual(['/ndvi', '/ndwi']);
  });
});

// ---------------------------------------------------------------------------
// 3. fetch-imagery -> ndvi (dependency success)
// ---------------------------------------------------------------------------
describe('M2 — fetch-imagery -> ndvi chaining', () => {
  test('REAL acquired raster is injected into the ndvi payload (true chaining)', async () => {
    const calls = captureCalls();
    mockCallMlService.__fetchResult = {
      tool: 'fetch-imagery',
      status: 'success',
      result: {
        images: [
          { modality: 'optical', source: 'sentinel-2', filePath: '/real/gee/fetched/optical.tif', downloaded: true, product_id: 'S2A_1', captureDate: '2026-06-01', validated: true },
          { modality: 'sar', source: 'sentinel-1', filePath: '/real/gee/fetched/sar.tif', downloaded: true, product_id: 'S1A_1', captureDate: '2026-06-04', validated: true }
        ],
        date_gap_days: 3,
        source: 'gee'
      },
      confidence: 1.0,
      metadata: { data_source: 'gee' }
    };

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'fetch imagery for this region and calculate NDVI',
        imageRefs: [String(tile._id)],
        parameters: { bounding_box: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');

    const ndviCall = calls.find(c => c.endpoint === '/ndvi');
    expect(ndviCall).toBeTruthy();
    // The ndvi payload must reference the FETCHED raster, not the original upload.
    expect(ndviCall.payload.image_path).toBe('/real/gee/fetched/optical.tif');
    expect(ndviCall.payload.image_path).not.toBe('/tmp/uploaded-original.png');

    // dependency metadata surfaced on the ndvi result
    const ndviEntry = res.body.toolResults.find(t => t.tool === 'ndvi');
    expect(ndviEntry.metadata.dependency).toBe('fetch-imagery');
    expect(ndviEntry.metadata.dependencyNote).toContain('fetched optical raster');
  });

  test('mock/no-raster acquisition does NOT claim fetched imagery was analyzed', async () => {
    const calls = captureCalls();
    mockCallMlService.__fetchResult = {
      tool: 'fetch-imagery',
      status: 'success',
      result: {
        images: [
          { modality: 'optical', filePath: 'mock-no-file', downloaded: false },
          { modality: 'sar', filePath: null, downloaded: false }
        ],
        source: 'mock'
      },
      confidence: 0.7,
      metadata: { mock: true }
    };

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'fetch imagery for this region and calculate NDVI',
        imageRefs: [String(tile._id)],
        parameters: { bounding_box: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }
      });

    expect(res.status).toBe(200);
    const ndviCall = calls.find(c => c.endpoint === '/ndvi');
    // NDVI still runs (backward compat) but on the ORIGINAL upload, clearly labeled.
    expect(ndviCall.payload.image_path).toBe('/tmp/uploaded-original.png');
    const ndviEntry = res.body.toolResults.find(t => t.tool === 'ndvi');
    expect(ndviEntry.metadata.dependencyNote).toContain('no usable raster');
    expect(ndviEntry.metadata.dependencyNote).toContain('not fetched');
  });
});

// ---------------------------------------------------------------------------
// 4. Dependency failure propagation
// ---------------------------------------------------------------------------
describe('M2 — dependency failure propagation', () => {
  test('fetch-imagery FAILS -> ndvi is SKIPPED, never run on unrelated tiles', async () => {
    captureCalls();
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/fetch-imagery') {
        return { tool: 'fetch-imagery', status: 'failed', result: { error: 'GEE acquisition unavailable' }, confidence: 0 };
      }
      // Any other call would be a violation: ndvi must NOT execute.
      throw new Error(`unexpected call to ${endpoint}`);
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'fetch imagery for this region and calculate NDVI',
        imageRefs: [String(tile._id)],
        parameters: { bounding_box: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }
      });

    expect(res.status).toBe(200);
    const tools = res.body.toolResults.map(t => t.tool);
    expect(tools).toEqual(['fetch-imagery', 'ndvi']);

    const fetchEntry = res.body.toolResults.find(t => t.tool === 'fetch-imagery');
    expect(fetchEntry.status).toBe('failed');
    expect(fetchEntry.error).toContain('GEE acquisition unavailable');

    const ndviEntry = res.body.toolResults.find(t => t.tool === 'ndvi');
    expect(ndviEntry.status).toBe('skipped');
    expect(ndviEntry.error).toContain('fetch-imagery');
    expect(ndviEntry.result).toEqual({});

    // no /ndvi call was made (mock throws if it is)
    expect(res.body.status).toBe('failed');

    const skipEntries = res.body.executionTrace.filter(e => e.step === 'tool_execution_skipped');
    expect(skipEntries.length).toBe(1);
    expect(skipEntries[0].detail).toContain('"ndvi" skipped');
  });

  test('change FAILS -> dependent area is SKIPPED/not executed', async () => {
    const calls = captureCalls();
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/change') {
        return { tool: 'change', status: 'failed', result: { error: 'co-registration failed' }, confidence: 0 };
      }
      throw new Error(`unexpected call to ${endpoint}`);
    });

    const t1 = await createTile({ captureDate: new Date('2025-01-01') });
    const t2 = await createTile({ captureDate: new Date('2025-06-01') });
    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'compare these images and calculate the changed area',
        imageRefs: [String(t1._id), String(t2._id)]
      });

    expect(res.status).toBe(200);
    expect(res.body.toolResults.map(t => t.tool)).toEqual(['change', 'area']);
    expect(res.body.toolResults.find(t => t.tool === 'change').status).toBe('failed');
    const areaEntry = res.body.toolResults.find(t => t.tool === 'area');
    expect(areaEntry.status).toBe('skipped');
    expect(areaEntry.error).toContain('change');
    expect(calls.find(c => c.endpoint === '/area')).toBeUndefined();
    expect(res.body.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 5. change -> area
// ---------------------------------------------------------------------------
describe('M2 — change -> area chaining', () => {
  test('change provides changed_area_km2 -> area is DERIVED from change (no fake /area call)', async () => {
    const calls = captureCalls();
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/change') {
        return {
          tool: 'change',
          status: 'success',
          result: { change_percentage: 8.4, changed_area_km2: 3.1416, mean_difference: 0.4, summary: 'urban expansion' },
          confidence: 0.94,
          evidence: { image1: { filename: 'a.tif' }, image2: { filename: 'b.tif' } }
        };
      }
      if (endpoint === '/area') throw new Error('unexpected /area call');
      return null;
    });

    const t1 = await createTile({ captureDate: new Date('2025-01-01') });
    const t2 = await createTile({ captureDate: new Date('2025-06-01') });
    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'compare these images and calculate the changed area',
        imageRefs: [String(t1._id), String(t2._id)]
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.toolResults.map(t => t.tool)).toEqual(['change', 'area']);

    const areaEntry = res.body.toolResults.find(t => t.tool === 'area');
    expect(areaEntry.status).toBe('success');
    // Truthful chaining: the area IS the change tool's computed value.
    expect(areaEntry.result.area_km2).toBe(3.1416);
    expect(areaEntry.result.source).toBe('change.changed_area_km2');
    expect(areaEntry.metadata.derivedFrom).toBe('change.changed_area_km2');

    // No /area ML call happened — we never faked a raster handoff.
    expect(calls.find(c => c.endpoint === '/area')).toBeUndefined();

    const derivedTrace = res.body.executionTrace.filter(e => e.step === 'tool_execution_derived');
    expect(derivedTrace.length).toBe(1);
    expect(derivedTrace[0].detail).toContain('change.changed_area_km2');
  });

  test('change returns NO changed_area_km2 -> area executes with change context attached', async () => {
    const calls = captureCalls();
    const t1 = await createTile({ captureDate: new Date('2025-01-01') });
    const t2 = await createTile({ captureDate: new Date('2025-06-01') });
    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'compare these images and calculate the changed area',
        imageRefs: [String(t1._id), String(t2._id)]
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.toolResults.map(t => t.tool)).toEqual(['change', 'area']);

    const areaCall = calls.find(c => c.endpoint === '/area');
    expect(areaCall).toBeTruthy();
    // Change context is exposed to the area payload, labeled as change-derived.
    expect(areaCall.payload.change_context).toBeDefined();
    expect(areaCall.payload.feature_type).toBe('changed_area');
  });

  test('standalone AREA carries no change dependency artifacts', async () => {
    const calls = captureCalls();
    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'calculate the surface area', imageRefs: [String(tile._id)] });

    expect(res.body.status).toBe('success');
    const areaEntry = res.body.toolResults.find(t => t.tool === 'area');
    expect({ ...(areaEntry.metadata || {}) }).not.toHaveProperty('dependency');
    expect(areaEntry.status).toBe('success');
    const areaCall = calls.find(c => c.endpoint === '/area');
    expect(areaCall.payload.change_context).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Independent failures must not block unrelated tools
// ---------------------------------------------------------------------------
describe('M2 — independent failure isolation', () => {
  test('ndvi FAILS -> ndwi still executes and is reported', async () => {
    const calls = [];
    mockCallMlService.mockImplementation(async (endpoint) => {
      calls.push(endpoint);
      if (endpoint === '/ndvi') return { tool: 'ndvi', status: 'failed', result: { error: 'no NIR band' }, confidence: 0 };
      if (endpoint === '/ndwi') return { tool: 'ndwi', status: 'success', result: { value: 0.4 }, confidence: 0.9 };
      throw new Error(`unexpected call to ${endpoint}`);
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'calculate NDVI and NDWI', imageRefs: [String(tile._id)] });

    expect(calls).toEqual(['/ndvi', '/ndwi']);
    expect(res.body.status).toBe('partial');
    expect(res.body.toolResults.find(t => t.tool === 'ndvi').status).toBe('failed');
    expect(res.body.toolResults.find(t => t.tool === 'ndwi').status).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// 7/8. Dependency isolation + payload non-contamination
// ---------------------------------------------------------------------------
describe('M2 — dependency result isolation', () => {
  test('a result from tool A never leaks into unrelated tool B payloads', async () => {
    const calls = captureCalls();
    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'calculate NDVI and NDWI', imageRefs: [String(tile._id)] });

    expect(res.body.status).toBe('success');
    const ndviCall = calls.find(c => c.endpoint === '/ndvi');
    const ndwiCall = calls.find(c => c.endpoint === '/ndwi');

    // ndwi has no dependency on ndvi -> payload must reference only the original tile
    expect(ndwiCall.payload.image_path).toBe('/tmp/uploaded-original.png');
    expect(ndwiCall.payload.image_path).toBe(ndviCall.payload.image_path);
    expect(JSON.stringify(ndwiCall.payload)).not.toContain('value');
  });
});

// ---------------------------------------------------------------------------
// 9. Original inputs are never mutated
// ---------------------------------------------------------------------------
describe('M2 — input immutability', () => {
  test('executeTools does not mutate the original tiles array', async () => {
    const tools = await planTools('NDVI', ['fetch-imagery', 'ndvi'], []);
    const t1 = await createTile({ modality: 'optical', filePath: '/real/uploads/a.png', captureDate: new Date('2025-01-01') });
    const t2 = await createTile({ modality: 'sar', filePath: '/real/uploads/b.tif', captureDate: new Date('2025-02-01') });
    const tiles = [t1, t2];

    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/fetch-imagery') {
        return { tool: 'fetch-imagery', status: 'success', result: { images: [], source: 'mock' }, confidence: 0.7 };
      }
      if (endpoint === '/ndvi') return { tool: 'ndvi', status: 'success', result: { value: 0.5 }, confidence: 0.9 };
      return null;
    });

    const before = JSON.parse(JSON.stringify(tiles));
    await executeTools(tools, tiles, { featureType: 'x' }, [], tools.plan);

    expect(JSON.parse(JSON.stringify(tiles))).toEqual(before);
  });

  test('executeTools does not mutate the original parameters object', async () => {
    const tools = await planTools('CHANGE_ANALYSIS', ['change', 'area'], []);
    const t1 = await createTile({ captureDate: new Date('2025-01-01') });
    const t2 = await createTile({ captureDate: new Date('2025-06-01') });
    const tiles = [t1, t2];

    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/change') return { tool: 'change', status: 'success', result: { change_percentage: 8.4 }, confidence: 0.9 };
      if (endpoint === '/area') return { tool: 'area', status: 'success', result: { area_km2: 12.3 }, confidence: 0.9 };
      return null;
    });

    const parameters = { featureType: 'changed_area', region: { type: 'Polygon', coordinates: [] } };
    const before = JSON.parse(JSON.stringify(parameters));
    await executeTools(tools, tiles, parameters, [], tools.plan);

    expect(parameters).toEqual(before);
    // tiles untouched as well
    expect(tiles).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 10. Trust layer — trace + evidence
// ---------------------------------------------------------------------------
describe('M2 — execution trace reflects dependency behavior', () => {
  test('skipped dependency produces an explicit trace entry', async () => {
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/fetch-imagery') {
        return { tool: 'fetch-imagery', status: 'failed', result: { error: 'down' }, confidence: 0 };
      }
      throw new Error(`unexpected ${endpoint}`);
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'fetch imagery for this region and calculate NDVI',
        imageRefs: [String(tile._id)],
        parameters: { bounding_box: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }
      });

    const steps = res.body.executionTrace.map(e => e.step);
    expect(steps).toContain('tool_execution_skipped');
    expect(steps).toContain('tool_execution_failed');

    const skip = res.body.executionTrace.find(e => e.step === 'tool_execution_skipped');
    expect(skip.detail).toContain('ndvi');
    expect(skip.detail).toContain('fetch-imagery');
  });

  test('successful dependency execution is represented in the trace', async () => {
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/ndvi') return { tool: 'ndvi', status: 'success', result: { value: 0.5 }, confidence: 0.9 };
      if (endpoint === '/ndwi') return { tool: 'ndwi', status: 'success', result: { value: 0.4 }, confidence: 0.9 };
      return null;
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'calculate NDVI and NDWI', imageRefs: [String(tile._id)] });

    expect(res.body.plan.steps.map(s => s.tool)).toEqual(['ndvi', 'ndwi']);
    expect(res.body.plan.steps.map(s => s.dependsOn)).toEqual([[], []]);
    const successEntries = res.body.executionTrace.filter(e => e.step === 'tool_execution_success');
    expect(successEntries.map(e => e.detail)).toEqual([
      expect.stringContaining('"ndvi"'),
      expect.stringContaining('"ndwi"')
    ]);
  });
});

// ---------------------------------------------------------------------------
// 11. Persistence
// ---------------------------------------------------------------------------
describe('M2 — persistence of dependency-aware execution', () => {
  test('stored Query retains plan, toolsInvoked, toolResults (incl. skipped), and trace', async () => {
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/fetch-imagery') {
        return { tool: 'fetch-imagery', status: 'failed', result: { error: 'GEE unavailable' }, confidence: 0 };
      }
      throw new Error(`unexpected ${endpoint}`);
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'fetch imagery for this region and calculate NDVI',
        imageRefs: [String(tile._id)],
        parameters: { bounding_box: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }
      });

    const stored = await Query.findById(res.body._id);

    // plan
    expect(stored.plan.taskType).toBe('NDVI');
    expect(stored.plan.steps.map(s => s.tool)).toEqual(['fetch-imagery', 'ndvi']);
    expect(stored.plan.steps[1].dependsOn).toEqual(['fetch-imagery']);

    // toolsInvoked
    expect(stored.toolsInvoked).toEqual(['fetch-imagery', 'ndvi']);

    // toolResults incl. skipped status
    expect(stored.toolResults).toHaveLength(2);
    expect(stored.toolResults.find(t => t.tool === 'fetch-imagery').status).toBe('failed');
    const storedNdvi = stored.toolResults.find(t => t.tool === 'ndvi');
    expect(storedNdvi.status).toBe('skipped');
    expect(storedNdvi.error).toContain('fetch-imagery');

    // executionTrace
    expect(Array.isArray(stored.executionTrace)).toBe(true);
    expect(stored.executionTrace.some(e => e.step === 'tool_execution_skipped')).toBe(true);
  });

  test('stored Query retains metadata on chained successes', async () => {
    mockCallMlService.__fetchResult = {
      tool: 'fetch-imagery',
      status: 'success',
      result: {
        images: [
          { modality: 'optical', filePath: '/real/fetched/o.tif', downloaded: true, product_id: 'P1' }
        ],
        source: 'gee'
      },
      confidence: 1.0,
      metadata: {}
    };
    const calls = captureCalls();

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'fetch imagery for this region and calculate NDVI',
        imageRefs: [String(tile._id)],
        parameters: { bounding_box: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }
      });

    const stored = await Query.findById(res.body._id);
    const storedNdvi = stored.toolResults.find(t => t.tool === 'ndvi');
    expect(storedNdvi.metadata.dependency).toBe('fetch-imagery');
    expect(storedNdvi.metadata.dependencyNote).toContain('fetched optical raster');
    expect(calls.find(c => c.endpoint === '/ndvi').payload.image_path).toBe('/real/fetched/o.tif');
  });
});