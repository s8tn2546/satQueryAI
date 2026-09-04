import { jest } from '@jest/globals';

// =============================================================================
// Agent Milestone — Deterministic Structured Multi-Tool Planner
//
// Verifies:
//  1. Single-tool plan ("calculate NDVI" -> ndvi)
//  2. Multiple independent tools ("calculate NDVI and NDWI" -> ndvi + ndwi)
//  3. Acquisition dependency ("fetch imagery and calculate NDVI" -> fetch-imagery -> ndvi)
//  4. Change->area dependency ("compare images and calculate changed area" -> change -> area)
//  5. Optical/SAR ("analyze optical and SAR imagery" -> optical_sar)
//  6. Missing pair input never pretends a second image exists
//  7. Ambiguous query ("analyze this image") keeps safe default (vqa)
//  8. A plan never contains an unregistered tool
//  9. Determinism: same query + same inputs -> same plan
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
const { default: ToolRegistry } = await import('../src/models/ToolRegistry.js');
const { classifyIntent } = await import('../src/agents/intentClassifier.js');
const { buildPlan, planTools } = await import('../src/agents/taskPlanner.js');

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
    filePath: '/tmp/fake.png',
    validated: true,
    validationDetails: {},
    ...overrides
  });
}

function names(plan) {
  return plan.steps.map(s => s.tool);
}

describe('Structured task planner (buildPlan)', () => {
  test('single tool task-default plan', async () => {
    const plan = await buildPlan('NDVI', []);
    expect(plan).toEqual({
      taskType: 'NDVI',
      steps: [{ order: 1, tool: 'ndvi', reason: expect.any(String), dependsOn: [] }]
    });
  });

  test('NDVI+NDWI are planned as two independent steps (no invented dependency)', async () => {
    const plan = await buildPlan('NDVI', ['ndvi', 'ndwi']);
    expect(names(plan)).toEqual(['ndvi', 'ndwi']);
    expect(plan.steps.map(s => s.order)).toEqual([1, 2]);
    expect(plan.steps.map(s => s.dependsOn)).toEqual([[], []]);
  });

  test('fetch-imagery precedes analysis and the analysis step depends on it', async () => {
    const plan = await buildPlan('NDVI', ['fetch-imagery', 'ndvi']);
    expect(names(plan)).toEqual(['fetch-imagery', 'ndvi']);
    expect(plan.steps[0]).toMatchObject({ order: 1, tool: 'fetch-imagery', dependsOn: [] });
    expect(plan.steps[1]).toMatchObject({ order: 2, tool: 'ndvi', dependsOn: ['fetch-imagery'] });
  });

  test('area depends on change when both are planned (change -> area)', async () => {
    const plan = await buildPlan('CHANGE_ANALYSIS', ['change', 'area']);
    expect(names(plan)).toEqual(['change', 'area']);
    expect(plan.steps[0]).toMatchObject({ order: 1, tool: 'change', dependsOn: [] });
    expect(plan.steps[1]).toMatchObject({ order: 2, tool: 'area', dependsOn: ['change'] });
  });

  test('optical_sar default plan', async () => {
    const plan = await buildPlan('OPTICAL_SAR', []);
    expect(names(plan)).toEqual(['optical_sar']);
    expect(plan.steps[0].dependsOn).toEqual([]);
  });

  test('vqa/caption/ground are preserved (not removed)', async () => {
    expect(names(await buildPlan('VQA', []))).toEqual(['vqa']);
    expect(names(await buildPlan('CAPTION', []))).toEqual(['caption']);
    expect(names(await buildPlan('GROUNDING', []))).toEqual(['ground']);
  });

  test('never plans an unregistered/unknown tool', async () => {
    const plan = await buildPlan('NDVI', ['comet_analyzer', 'ndvi']);
    expect(names(plan)).toEqual(['ndvi']);

    const fallbackPlan = await buildPlan('NDVI', ['comet_analyzer']);
    expect(names(fallbackPlan)).toEqual(['ndvi']);

    const registeredNames = new Set((await ToolRegistry.find()).map(t => t.name));
    for (const step of [...plan.steps, ...fallbackPlan.steps]) {
      expect(registeredNames.has(step.tool)).toBe(true);
    }
  });

  test('a known-but-unregistered tool is never emitted', async () => {
    await ToolRegistry.deleteOne({ name: 'ndwi' });
    try {
      const plan = await buildPlan('NDWI', ['ndwi']);
      expect(names(plan)).toEqual([]);
    } finally {
      await seedTools();
    }
  });

  test('is deterministic for identical inputs', async () => {
    const a = await buildPlan('NDVI', ['fetch-imagery', 'ndvi']);
    const b = await buildPlan('NDVI', ['fetch-imagery', 'ndvi']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('Intent classification → tool suggestions', () => {
  const trace = [];
  const tiles = [{ modality: 'optical', format: 'png' }];

  test('"calculate NDVI" -> ndvi', async () => {
    const r = await classifyIntent('calculate NDVI', tiles, trace);
    expect(r.taskType).toBe('NDVI');
    expect(r.toolNames).toEqual(['ndvi']);
  });

  test('"calculate NDVI and NDWI" -> ndvi + ndwi', async () => {
    const r = await classifyIntent('calculate NDVI and NDWI', tiles, trace);
    expect(r.taskType).toBe('NDVI');
    expect(r.toolNames).toEqual(['ndvi', 'ndwi']);
  });

  test('"fetch imagery and calculate NDVI" -> fetch-imagery + ndvi', async () => {
    const r = await classifyIntent('fetch imagery and calculate NDVI', tiles, trace);
    expect(r.taskType).toBe('NDVI');
    expect(r.toolNames).toEqual(['fetch-imagery', 'ndvi']);
  });

  test('"compare these images and calculate the changed area" -> change + area', async () => {
    const r = await classifyIntent('compare these images and calculate the changed area', tiles, trace);
    expect(r.taskType).toBe('CHANGE_ANALYSIS');
    expect(r.toolNames).toEqual(['change', 'area']);
  });

  test('"analyze optical and SAR imagery" -> optical_sar', async () => {
    const r = await classifyIntent('analyze optical and SAR imagery', tiles, trace);
    expect(r.taskType).toBe('OPTICAL_SAR');
    expect(r.toolNames).toEqual(['optical_sar']);
  });

  test('"analyze this image" keeps the safe VQA default', async () => {
    const r = await classifyIntent('analyze this image', tiles, trace);
    expect(r.taskType).toBe('VQA');
    expect(r.toolNames).toEqual(['vqa']);
  });

  test('classification is deterministic for identical inputs', async () => {
    const a = await classifyIntent('calculate NDVI and NDWI', tiles, []);
    const b = await classifyIntent('calculate NDVI and NDWI', tiles, []);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('Query → structured plan composition', () => {
  test.each([
    ['calculate NDVI', undefined, ['ndvi']],
    ['calculate NDVI and NDWI', undefined, ['ndvi', 'ndwi']],
    ['fetch imagery and calculate NDVI', undefined, ['fetch-imagery', 'ndvi']],
    ['compare these images and calculate the changed area', undefined, ['change', 'area']],
    ['analyze optical and SAR imagery', undefined, ['optical_sar']],
    ['analyze this image', undefined, ['vqa']]
  ])('"%s" plans exactly %j', async (query, _ignored, expectedTools) => {
    const { taskType, toolNames } = await classifyIntent(query, [{ modality: 'optical' }], []);
    const plan = await buildPlan(taskType, toolNames);
    expect(names(plan)).toEqual(expectedTools);
  });

  test('fetch-imagery dependency is encoded in the composed plan', async () => {
    const { taskType, toolNames } = await classifyIntent('fetch imagery and calculate NDVI', [{ modality: 'optical' }], []);
    const plan = await buildPlan(taskType, toolNames);
    expect(plan.steps[1].dependsOn).toEqual(['fetch-imagery']);
  });

  test('change -> area dependency is encoded in the composed plan', async () => {
    const { taskType, toolNames } = await classifyIntent('compare these images and calculate the changed area', [{ modality: 'optical' }], []);
    const plan = await buildPlan(taskType, toolNames);
    expect(plan.steps[1]).toMatchObject({ tool: 'area', dependsOn: ['change'] });
  });
});

describe('Pipeline behavior (plan shapes + input safety)', () => {
  test('missing pair input never executes: change request with one image is rejected before any ML call', async () => {
    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'compare these images and calculate the changed area',
        imageRefs: [String(tile._id)]
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.taskType).toBe('CHANGE_ANALYSIS');
    expect(mockCallMlService).not.toHaveBeenCalled();
    expect(res.body.toolResults).toEqual([]);
  });

  test('ambiguous "analyze this image" resolves to the safe vqa default', async () => {
    mockCallMlService.mockResolvedValue({
      tool: 'vqa',
      status: 'success',
      result: { answer: 'Analysis complete.' },
      confidence: 0.9
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'analyze this image', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.plan.steps.map(s => s.tool)).toEqual(['vqa']);
    expect(res.body.plan.steps[0].dependsOn).toEqual([]);
    expect(mockCallMlService).toHaveBeenCalledWith('/vqa', expect.any(Object));
  });

  test('multi-tool plan is executed in order and surfaced in the response', async () => {
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/ndvi') return { tool: 'ndvi', status: 'success', result: { value: 0.5 }, confidence: 0.9 };
      if (endpoint === '/ndwi') return { tool: 'ndwi', status: 'success', result: { value: 0.4 }, confidence: 0.9 };
      return null;
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'calculate NDVI and NDWI', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.toolResults.map(t => t.tool)).toEqual(['ndvi', 'ndwi']);
    expect(res.body.plan.steps.map(s => s.tool)).toEqual(['ndvi', 'ndwi']);
    expect(res.body.plan.steps.map(s => s.order)).toEqual([1, 2]);
    const report = await request(app).get(`/api/query/${res.body._id}/report`);
    expect(report.body.toolsInvoked).toEqual(['ndvi', 'ndwi']);
  });

  test('change -> area end-to-end plan respects dependency order', async () => {
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/change') return { tool: 'change', status: 'success', result: { change_percentage: 8.4 }, confidence: 0.9 };
      if (endpoint === '/area') return { tool: 'area', status: 'success', result: { area_km2: 12.3 }, confidence: 0.9 };
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
    expect(res.body.taskType).toBe('CHANGE_ANALYSIS');
    expect(res.body.toolResults.map(t => t.tool)).toEqual(['change', 'area']);
    expect(res.body.plan.steps[0]).toMatchObject({ tool: 'change', order: 1, dependsOn: [] });
    expect(res.body.plan.steps[1]).toMatchObject({ tool: 'area', order: 2, dependsOn: ['change'] });

    const report = await request(app).get(`/api/query/${res.body._id}/report`);
    expect(report.body.toolsInvoked).toEqual(['change', 'area']);
  });

  test('fetch-imagery -> ndvi plan is executed and surfaced', async () => {
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/fetch-imagery') {
        return { tool: 'fetch-imagery', status: 'success', result: { images: [], source: 'mock' }, confidence: 0.7 };
      }
      if (endpoint === '/ndvi') return { tool: 'ndvi', status: 'success', result: { value: 0.55 }, confidence: 0.9 };
      return null;
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({
        queryText: 'fetch imagery and calculate NDVI',
        imageRefs: [String(tile._id)],
        parameters: { bounding_box: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.toolResults.map(t => t.tool)).toEqual(['fetch-imagery', 'ndvi']);
    expect(res.body.plan.steps[0]).toMatchObject({ tool: 'fetch-imagery', order: 1, dependsOn: [] });
    expect(res.body.plan.steps[1]).toMatchObject({ tool: 'ndvi', order: 2, dependsOn: ['fetch-imagery'] });

    const report = await request(app).get(`/api/query/${res.body._id}/report`);
    expect(report.body.toolsInvoked).toEqual(['fetch-imagery', 'ndvi']);
  });

  test('same query + same inputs produce the identical plan (determinism)', async () => {
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/ndvi') return { tool: 'ndvi', status: 'success', result: { value: 0.5 }, confidence: 0.9 };
      if (endpoint === '/ndwi') return { tool: 'ndwi', status: 'success', result: { value: 0.4 }, confidence: 0.9 };
      return null;
    });

    const tile = await createTile();
    const body = { queryText: 'calculate NDVI and NDWI', imageRefs: [String(tile._id)] };

    const first = await request(app).post('/api/query').send(body);
    const second = await request(app).post('/api/query').send(body);

    expect(JSON.stringify(first.body.plan)).toBe(JSON.stringify(second.body.plan));
  });

  test('planTools still returns registered tool documents for execution', async () => {
    const tools = await planTools('CHANGE_ANALYSIS', ['change', 'area'], []);
    expect(tools.map(t => t.name)).toEqual(['change', 'area']);
    expect(tools.plan.steps).toHaveLength(2);
  });
});