import { jest } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// =============================================================================
// Milestone 4 — End-to-end integration (real ML client, scripted fetches).
//
// Uses the REAL mlServiceClient/toolExecutor/pipeline against a stubbed
// global.fetch so we can verify exactly what wire payload reaches the ML
// service for each Geo/RS endpoint, without needing a live ML process.
// =============================================================================

const { MongoMemoryServer } = await import('mongodb-memory-server');
const mongoose = (await import('mongoose')).default;
const request = (await import('supertest')).default;
const { default: app } = await import('../src/index.js');
const { default: Tile } = await import('../src/models/Tile.js');
const { default: Query } = await import('../src/models/Query.js');
const { default: ResultsCache } = await import('../src/models/ResultsCache.js');
const { seedTools } = await import('../src/services/seedTools.js');

const ML_BASE = 'http://localhost:8000';

let mongod;
let originalFetch;
let requests = [];
let scripted = {};

function when(pathname, response) {
  scripted[pathname] = response;
}

async function capturedForm(pathname) {
  const req = requests.find(r => r.pathname === pathname);
  return req ? req.body : null;
}

async function capturedJson(pathname) {
  const form = await capturedForm(pathname);
  return typeof form === 'string' ? JSON.parse(form) : null;
}

let tmpDir;

async function makeTempFile(name, content) {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, content);
  return filePath;
}

async function fieldInfo(form, field) {
  const entry = form ? await form.get(field) : null;
  if (!entry) return null;
  return { name: entry.name, text: await entry.text() };
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'm4-e2e-'));
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seedTools();
  process.env.LLM_API_KEY = 'mock-llm-key';

  originalFetch = global.fetch;
  global.fetch = jest.fn(async (url, opts = {}) => {
    const { pathname } = new URL(url);
    requests.push({ pathname, body: opts.body, headers: opts.headers });
    const response = scripted[pathname];
    if (!response) {
      throw new Error(`No scripted response for ${pathname}`);
    }
    if (response.raw) return response.raw;
    return {
      ok: true,
      status: 200,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body)
    };
  });
});

afterAll(async () => {
  global.fetch = originalFetch;
  await mongoose.disconnect();
  await mongod.stop();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  requests = [];
  scripted = {};
  await Promise.all([
    mongoose.connection.collection('queries').deleteMany({}),
    mongoose.connection.collection('tiles').deleteMany({}),
    mongoose.connection.collection('resultscaches').deleteMany({})
  ]);
});

async function createTile(overrides = {}) {
  return Tile.create({
    source: 'benchmark-upload',
    modality: 'optical',
    format: 'tiff',
    filePath: await makeTempFile(`tile-${Date.now()}-${Math.random().toString(16).slice(2)}.tif`, 'RASTERBYTES'),
    validated: true,
    validationDetails: { validationStatus: 'valid' },
    ...overrides
  });
}

const CHANGE_RESULT_PAYLOAD = {
  tool: 'change',
  status: 'success',
  result: {
    change_percentage: 8.4,
    mean_diff: 1.2,
    max_diff: 3.0
  },
  evidence: { region: {}, notes: 'bi-temporal' },
  confidence: 0.9
};

describe('Milestone 4 — E2E tool transport (full API → agent → ML → DB path)', () => {
  it('CHANGE_ANALYSIS streams image1/image2 bytes to /change and persists the result to history/report', async () => {
    const t1 = await createTile({ captureDate: new Date('2025-01-01T00:00:00Z') });
    const t2 = await createTile({ captureDate: new Date('2025-06-01T00:00:00Z') });

    when('/change', { body: CHANGE_RESULT_PAYLOAD });

    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'How did the built-up area change between these two images?',
        imageRefs: [t1._id.toString(), t2._id.toString()]
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.taskType).toBe('CHANGE_ANALYSIS');
    expect(res.body.toolResults).toHaveLength(1);
    expect(res.body.toolResults[0].result.change_percentage).toBe(8.4);
    expect(res.body.answerText).toMatch(/8\.4/i);

    // The two tile files must have been streamed as multipart `image1`/`image2`.
    const form = await capturedForm('/change');
    expect(form).toBeTruthy();
    const image1 = await fieldInfo(form, 'image1');
    const image2 = await fieldInfo(form, 'image2');
    expect(image1.text).toBe('RASTERBYTES');
    expect(image2.text).toBe('RASTERBYTES');
    expect(image1.name).toMatch(/\.tif$/);
    expect(image2.name).toMatch(/\.tif$/);
    // Path/ID metadata keys must never leak as form fields.
    expect(await form.get('image_t1_path')).toBeNull();
    expect(await form.get('image_t2_path')).toBeNull();
    expect(await form.get('tile_id_t1')).toBeNull();

    // Persisted and re-served through the report endpoint.
    const report = await request(app).get(`/api/query/${res.body._id}/report`);
    expect(report.status).toBe(200);
    expect(report.body.toolResults[0].status).toBe('success');
    expect(report.body.toolsInvoked).toEqual(expect.arrayContaining(['change']));
    expect(report.body.answerText).toMatch(/8\.4/i);

    const history = await request(app).get('/api/query/history');
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].queryText).toContain('built-up area');
    expect(history.body[0].toolResults[0].result.change_percentage).toBe(8.4);
  });

  it('AREA streams the single file and forwards feature_type to /area', async () => {
    const t = await createTile();
    when('/area', {
      body: { tool: 'area', status: 'success', result: { area_km2: 12.5 }, confidence: 0.8 }
    });

    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'How large is the water body surface area in this image?',
        imageRefs: [t._id.toString()]
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.taskType).toBe('AREA');

    const form = await capturedForm('/area');
    expect(form).toBeTruthy();
    const file = await fieldInfo(form, 'file');
    expect(file.text).toBe('RASTERBYTES');
    expect(file.name).toMatch(/\.tif$/);
    expect(await form.get('image_path')).toBeNull();
    expect(await form.get('tile_id')).toBeNull();
    expect(await form.get('feature_type')).toBeNull(); // '' is dropped, not sent empty
  });

  it('history returns newest query first with full persisted toolResults', async () => {
    const t1 = await createTile({ captureDate: new Date('2025-01-01T00:00:00Z') });
    const t2 = await createTile({ captureDate: new Date('2025-06-01T00:00:00Z') });
    when('/change', { body: CHANGE_RESULT_PAYLOAD });
    await request(app)
      .post('/api/query')
      .send({ queryText: 'How did things change between these two?', imageRefs: [t1._id.toString(), t2._id.toString()] });

    when('/area', { body: { tool: 'area', status: 'success', result: { area_km2: 3.3 }, confidence: 0.75 } });
    await request(app)
      .post('/api/query')
      .send({ queryText: 'How big is the surface area?', imageRefs: [t1._id.toString()] });

    const history = await request(app).get('/api/query/history');
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(2);
    expect(history.body[0].taskType).toBe('AREA');
    expect(history.body[1].taskType).toBe('CHANGE_ANALYSIS');
  });
});

describe('Milestone 4 — raw multipart/JSON transport to each ML endpoint', () => {
  it('/ndvi, /ndwi, /validate stream the file under the `file` field', async () => {
    const ndviPath = await makeTempFile('ndvi.tif', 'NDVIBYTES');
    const ndwiPath = await makeTempFile('ndwi.tif', 'NDWIBYTES');
    const validatePath = await makeTempFile('v.tif', 'VALIDATEBYTES');

    when('/ndvi', { body: { status: 'success', result: { mean: 0.5 } } });
    when('/ndwi', { body: { status: 'success', result: { mean: 0.4 } } });
    when('/validate', { body: { status: 'success', result: { valid: true, validation_status: 'valid' } } });

    const { default: ml } = await import('../src/services/mlServiceClient.js');

    await ml.callMlService('/ndvi', { image_path: ndviPath, tile_id: 'ndvi-id' });
    await ml.callMlService('/ndwi', { image_path: ndwiPath });
    await ml.callMlService('/validate', { image_path: validatePath, modality_hint: 'optical', format: 'tiff' });

    for (const [endpoint, bytes, hintValue] of [
      ['/ndvi', 'NDVIBYTES', null],
      ['/ndwi', 'NDWIBYTES', null],
      ['/validate', 'VALIDATEBYTES', 'optical']
    ]) {
      const form = await capturedForm(endpoint);
      const file = await fieldInfo(form, 'file');
      expect(file).not.toBeNull();
      expect(file.text).toBe(bytes);
      if (hintValue) {
        expect(await form.get('modality_hint')).toBe(hintValue);
      } else {
        expect(await form.get('modality_hint')).toBeNull();
      }
      expect(await form.get('image_path')).toBeNull();
    }
  });

  it('/change uses image1/image2 and /optical-sar uses optical_image/sar_image', async () => {
    const t1Path = await makeTempFile('t1.tif', 'T1BYTES');
    const t2Path = await makeTempFile('t2.tif', 'T2BYTES');
    const opticalPath = await makeTempFile('o.tif', 'OPTBYTES');
    const sarPath = await makeTempFile('s.tif', 'SARBYTES');

    const { default: ml } = await import('../src/services/mlServiceClient.js');

    when('/change', { body: { status: 'success', result: { change_percentage: 1 } } });
    when('/optical-sar', { body: { status: 'success', result: { fused_land_cover: {} } } });

    await ml.callMlService('/change', { image_t1_path: t1Path, image_t2_path: t2Path, tile_id_t1: 'a', tile_id_t2: 'b' });
    await ml.callMlService('/optical-sar', { optical_path: opticalPath, sar_path: sarPath, optical_tile_id: 'o', sar_tile_id: 's' });

    const changeForm = await capturedForm('/change');
    expect((await fieldInfo(changeForm, 'image1')).text).toBe('T1BYTES');
    expect((await fieldInfo(changeForm, 'image2')).text).toBe('T2BYTES');
    expect(await changeForm.get('image_t1_path')).toBeNull();
    expect(await changeForm.get('tile_id_t1')).toBeNull();

    const sarForm = await capturedForm('/optical-sar');
    expect((await fieldInfo(sarForm, 'optical_image')).text).toBe('OPTBYTES');
    expect((await fieldInfo(sarForm, 'sar_image')).text).toBe('SARBYTES');
    expect(await sarForm.get('optical_path')).toBeNull();
  });

  it('/trend sends exactly the TrendRequest JSON (region, metric, start/end date, interval)', async () => {
    const { default: ml } = await import('../src/services/mlServiceClient.js');
    when('/trend', { body: { status: 'success', result: { series: [{ date: '2025-01-01', value: 0.5 }] }, confidence: 0.8 } });

    const region = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
    await ml.callMlService('/trend', {
      region,
      metric: 'ndvi',
      start_date: '2025-01-01',
      end_date: '2026-01-01',
      interval: 'monthly'
    });

    const body = await capturedJson('/trend');
    expect(body).toEqual({
      region,
      metric: 'ndvi',
      start_date: '2025-01-01',
      end_date: '2026-01-01',
      interval: 'monthly'
    });
    const req = requests.find(r => r.pathname === '/trend');
    expect(req.headers['Content-Type']).toContain('application/json');
  });

  it('/fetch-imagery sends JSON with bounding_box and date window', async () => {
    const { default: ml } = await import('../src/services/mlServiceClient.js');
    when('/fetch-imagery', { body: { status: 'success', result: { source: 'mock', images: [] } } });

    const boundingBox = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    await ml.callMlService('/fetch-imagery', {
      bounding_box: boundingBox,
      start_date: '2025-01-01',
      end_date: '2025-12-31'
    });

    expect(await capturedJson('/fetch-imagery')).toEqual({
      bounding_box: boundingBox,
      start_date: '2025-01-01',
      end_date: '2025-12-31'
    });
  });

  it('a missing local file is not silently sent — the multipart omits the file field', async () => {
    const { default: ml } = await import('../src/services/mlServiceClient.js');
    when('/ndvi', { body: { status: 'success', result: { mean: 0.5 } } });

    const result = await ml.callMlService('/ndvi', { image_path: '/no/such/file.tif', tile_id: 'x' });
    expect(result.status).toBe('success');

    const form = await capturedForm('/ndvi');
    expect(await form.get('file')).toBeNull();
  });
});

describe('Milestone 4 — HTTP failure and malformed responses from ML', () => {
  it('HTTP 4xx from ML falls back to a clearly-flagged mock result (no fake success)', async () => {
    const { default: ml } = await import('../src/services/mlServiceClient.js');
    requests = [];
    global.fetch.mockImplementationOnce(async () => ({
      ok: false,
      status: 422,
      text: async () => 'file could not be parsed'
    }));

    const result = await ml.callMlService('/area', { image_path: '/tmp/x.tif', tile_id: 'a' });
    expect(result.status).toBe('success');
    expect(result.metadata.mock).toBe(true);
  });

  it('HTTP 5xx from ML falls back to a clearly-flagged mock result', async () => {
    const { default: ml } = await import('../src/services/mlServiceClient.js');
    global.fetch.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      text: async () => 'nope'
    }));

    const result = await ml.callMlService('/ndvi', { image_path: '/tmp/x.tif', tile_id: 'a' });
    expect(result.status).toBe('success');
    expect(result.metadata.mock).toBe(true);
  });

  it('malformed JSON (HTTP ok) falls back to a mock result instead of crashing', async () => {
    const { default: ml } = await import('../src/services/mlServiceClient.js');
    global.fetch.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
      text: async () => 'not-json'
    }));

    const result = await ml.callMlService('/ndwi', { image_path: '/tmp/x.tif', tile_id: 'a' });
    expect(result.status).toBe('success');
    expect(result.metadata.mock).toBe(true);
  });
});

describe('Milestone 4 — failure-path consistency at the pipeline level', () => {
  it('partial tool result is preserved in toolResults (not fabricated, not dropped)', async () => {
    const t1 = await createTile({ captureDate: new Date('2025-01-01T00:00:00Z') });
    const t2 = await createTile({ captureDate: new Date('2025-06-01T00:00:00Z') });

    when('/change', {
      body: {
        tool: 'change',
        status: 'partial',
        result: { change_percentage: 5.0 },
        evidence: { notes: 'partial' },
        confidence: 0.5
      }
    });

    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'How did the area change between these two images?', imageRefs: [t1._id.toString(), t2._id.toString()] });

    expect(res.status).toBe(200);
    expect(['partial', 'failed']).toContain(res.body.status);
    expect(res.body.toolResults).toHaveLength(1);
    expect(res.body.toolResults[0].status).toBe('partial');
    expect(res.body.toolResults[0].result.change_percentage).toBe(5.0);
  });

  it('ML success with an empty/missing result surfaces an honest failed tool (no fake result)', async () => {
    const t = await createTile();
    when('/area', { body: { tool: 'area', status: 'success', confidence: 0.9 } });

    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'How large is the surface area here?', imageRefs: [t._id.toString()] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.toolResults[0].status).toBe('failed');
    expect(res.body.toolResults[0].error).toMatch(/empty or malformed result/i);
    expect(res.body.answerText).toMatch(/empty or malformed result/i);
  });

  it('ML returning explicit failed status produces a failed response with the reason preserved', async () => {
    const t = await createTile();
    when('/area', {
      body: { tool: 'area', status: 'failed', result: { error: 'Insufficient cloud-free pixels (55% cloud)' }, confidence: 0 }
    });

    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'How big is the water body surface area?', imageRefs: [t._id.toString()] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.answerText).toMatch(/Insufficient cloud-free pixels/i);
  });
});

describe('Milestone 4 — trend cache identity includes interval (BACKEND.md §15.5)', () => {
  it('monthly and yearly for the same region/dates are distinct cached entries, each served correctly', async () => {
    const region = { type: 'Polygon', coordinates: [[[77.0, 28.0], [77.1, 28.0], [77.1, 28.1], [77.0, 28.1], [77.0, 28.0]]] };

    when('/trend', {
      body: {
        status: 'success',
        tool: 'trend',
        result: {
          metric: 'ndvi',
          series: [
            { date: '2025-01-01', value: 0.5 },
            { date: '2025-07-01', value: 0.6 }
          ],
          interval: 'monthly'
        },
        confidence: 0.8
      }
    });

    const monthly = await request(app)
      .post('/api/query/trend')
      .send({ region, metric: 'ndvi', startDate: '2025-01-01', endDate: '2026-01-01', interval: 'monthly' });
    expect(monthly.status).toBe(200);
    expect(monthly.body.status).toBe('success');
    expect(monthly.body.cache.hit).toBe(false);

    // Second interval is a legitimate NEW cache identity (BACKEND.md §15.5).
    when('/trend', {
      body: {
        status: 'success',
        tool: 'trend',
        result: {
          metric: 'ndvi',
          series: [
            { date: '2025-01-01', value: 0.51 },
            { date: '2026-01-01', value: 0.61 }
          ],
          interval: 'yearly'
        },
        confidence: 0.75
      }
    });

    const yearly = await request(app)
      .post('/api/query/trend')
      .send({ region, metric: 'ndvi', startDate: '2025-01-01', endDate: '2026-01-01', interval: 'yearly' });
    expect(yearly.status).toBe(200);
    expect(yearly.body.status).toBe('success');
    expect(yearly.body.cache.hit).toBe(false);

    // Both intervals cached independently (unique index must include interval).
    const entries = await ResultsCache.find({ metric: 'ndvi' }).sort({ interval: 1 });
    expect(entries.map(e => e.interval)).toEqual(['monthly', 'yearly']);

    // A repeat yearly request is now a cache HIT and returns the yearly series.
    const yearlyRepeat = await request(app)
      .post('/api/query/trend')
      .send({ region, metric: 'ndvi', startDate: '2025-01-01', endDate: '2026-01-01', interval: 'yearly' });
    expect(yearlyRepeat.body.cache.hit).toBe(true);
    expect(yearlyRepeat.body.result.interval).toBe('yearly');
  });
});