import { jest } from '@jest/globals';

const mockCallMlService = jest.fn();
const mockClassifyIntent = jest.fn();

jest.unstable_mockModule('../src/services/mlServiceClient.js', () => ({
  default: { callMlService: mockCallMlService }
}));

jest.unstable_mockModule('../src/agents/intentClassifier.js', () => ({
  classifyIntent: mockClassifyIntent
}));

const { MongoMemoryServer } = await import('mongodb-memory-server');
const mongoose = (await import('mongoose')).default;
const request = (await import('supertest')).default;
const { default: app } = await import('../src/index.js');
const { seedTools } = await import('../src/services/seedTools.js');
const { default: Tile } = await import('../src/models/Tile.js');
const { default: Query } = await import('../src/models/Query.js');
const { estimateConfidence } = await import('../src/agents/confidenceEstimator.js');

const VQA_RESULT = {
  tool: 'vqa',
  status: 'success',
  result: { answer: 'Dense urban settlement with road network visible.', confidence: 0.9 },
  evidence: { images: ['tid-vqa'], region: {}, notes: 'VQA inference completed successfully.' },
  confidence: 0.9,
  metadata: {}
};

const CAPTION_RESULT = {
  tool: 'caption',
  status: 'success',
  result: { caption: 'Mixed land cover with built-up, roads, and vegetation.', keywords: ['urban', 'vegetation'] },
  evidence: { images: ['tid-caption'], region: {}, notes: 'Caption generated for the scene.' },
  confidence: 0.88,
  metadata: {}
};

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
  mockClassifyIntent.mockReset();
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

function mockSuccessTwoTools() {
  mockClassifyIntent.mockResolvedValue({
    taskType: 'VQA',
    toolNames: ['vqa', 'caption'],
    parameters: { question: 'What is visible in this image?' }
  });
  mockCallMlService.mockImplementation(async (endpoint) => {
    if (endpoint === '/vqa') return VQA_RESULT;
    if (endpoint === '/caption') return CAPTION_RESULT;
    return null;
  });
}

describe('Agent M3 — Core B: multi-tool evidence aggregation', () => {
  it('aggregates evidence.images and evidence.notes across every successful tool in execution order', async () => {
    mockSuccessTwoTools();
    const tile = await createTile();

    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'What is visible in this image?', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.toolResults.map(t => t.tool)).toEqual(['vqa', 'caption']);

    // Images from BOTH tools, in execution order, after the user image refs.
    expect(res.body.evidence.images).toEqual([String(tile._id), 'tid-vqa', 'tid-caption']);

    // Notes from BOTH tools, in execution order.
    const notes = res.body.evidence.notes;
    expect(notes).toContain('VQA inference completed successfully.');
    expect(notes).toContain('Caption generated for the scene.');
    expect(notes.indexOf('VQA inference')).toBeLessThan(notes.indexOf('Caption generated'));

    // Backward compatibility: `result` remains the FIRST successful tool result.
    expect(res.body.result).toEqual(VQA_RESULT.result);
  });

  it('failed/skipped tools do NOT contribute success evidence, but are called out in notes', async () => {
    mockClassifyIntent.mockResolvedValue({
      taskType: 'VQA',
      toolNames: ['vqa', 'change', 'area'],
      parameters: { question: 'What changed?' }
    });
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/vqa') return VQA_RESULT;
      if (endpoint === '/change') return { status: 'error', error: 'change model unavailable' };
      if (endpoint === '/area') throw new Error('/area should be skipped — not called');
      return null;
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'What is visible?', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('partial');
    expect(res.body.toolResults.map(t => t.tool)).toEqual(['vqa', 'change', 'area']);
    expect(res.body.toolResults.map(t => t.status)).toEqual(['success', 'failed', 'skipped']);

    // `area` must never have been executed after its `change` dependency failed.
    expect(mockCallMlService).not.toHaveBeenCalledWith('/area', expect.anything());

    // Only the successful tool contributes evidence images.
    expect(res.body.evidence.images).toEqual([String(tile._id), 'tid-vqa']);
    expect(res.body.evidence.images).not.toContain('tid-change');
    expect(res.body.evidence.images).not.toContain('tid-area');

    // Honest notes for the failure/skip.
    const notes = res.body.evidence.notes;
    expect(notes).toContain('Tool "change" failed: change model unavailable');
    expect(notes).toContain('Tool "area" skipped:');
  });
});

describe('Agent M3 — Core C: confidence signal transparency', () => {
  it('returns confidenceSignals matching the estimator output, persists them, and exposes them in the report', async () => {
    mockSuccessTwoTools();
    const tile = await createTile();

    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'What is visible in this image?', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);

    const expected = estimateConfidence({ valid: true, warnings: [] }, [VQA_RESULT, CAPTION_RESULT]);

    // Signals correspond exactly to the estimator output (no route-level regeneration).
    expect(res.body.confidenceSignals).toEqual(expected.signals);
    // Existing confidence field unchanged in value and semantics.
    expect(res.body.confidence).toBe(expected.score);

    // Persisted on the query document.
    const stored = await Query.findById(res.body._id);
    expect(stored.confidenceSignals).toEqual(expected.signals);

    // Exposed through the report endpoint.
    const report = await request(app).get(`/api/query/${res.body._id}/report`);
    expect(report.status).toBe(200);
    expect(report.body.confidenceSignals).toEqual(expected.signals);
  });

  it('partially-failed execution still returns the real estimator signals', async () => {
    mockClassifyIntent.mockResolvedValue({
      taskType: 'VQA',
      toolNames: ['vqa', 'change', 'area'],
      parameters: { question: 'What changed?' }
    });
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/vqa') return VQA_RESULT;
      if (endpoint === '/change') return { status: 'error', error: 'change model unavailable' };
      if (endpoint === '/area') throw new Error('/area should be skipped — not called');
      return null;
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'What is visible?', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('partial');

    const changeFailed = { tool: 'change', status: 'failed', result: {}, evidence: {}, error: 'change model unavailable', confidence: 0 };
    const areaSkipped = { tool: 'area', status: 'skipped', result: {}, evidence: {}, error: 'Skipped: dependency failed', confidence: 0 };
    const expected = estimateConfidence({ valid: true, warnings: [] }, [VQA_RESULT, changeFailed, areaSkipped]);

    expect(res.body.confidenceSignals).toEqual(expected.signals);
    expect(res.body.confidence).toBe(expected.score);
  });

  it('rejected responses never claim confidence signals that were not calculated', async () => {
    mockClassifyIntent.mockResolvedValue({
      taskType: 'OPTICAL_SAR',
      toolNames: ['optical_sar'],
      parameters: {}
    });

    // Single optical image is structurally invalid for OPTICAL_SAR (needs a pair).
    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'Fuse this optical image.', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.confidenceSignals).toBeUndefined();

    const stored = await Query.findById(res.body._id);
    expect(stored.confidenceSignals).toBeUndefined();
  });
});