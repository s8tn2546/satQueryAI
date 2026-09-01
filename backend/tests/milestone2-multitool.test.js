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

const VQA_RESULT = {
  tool: 'vqa',
  status: 'success',
  result: { answer: 'Dense urban settlement with road network visible.', confidence: 0.9 },
  evidence: { image: 'tid', modality: 'optical' },
  confidence: 0.9,
  metadata: {}
};

const CAPTION_RESULT = {
  tool: 'caption',
  status: 'success',
  result: { caption: 'Mixed land cover with built-up, roads, and vegetation.', keywords: ['urban', 'vegetation'] },
  evidence: { image: 'tid', modality: 'optical' },
  confidence: 0.88,
  metadata: {}
};

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seedTools();
  process.env.LLM_API_KEY = 'mock-llm-key';
  mockClassifyIntent.mockResolvedValue({
    taskType: 'VQA',
    toolNames: ['vqa', 'caption'],
    parameters: { question: 'What is visible?' }
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  mockCallMlService.mockReset();
  mockClassifyIntent.mockReset();
  mockClassifyIntent.mockResolvedValue({
    taskType: 'VQA',
    toolNames: ['vqa', 'caption'],
    parameters: { question: 'What is visible?' }
  });
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

describe('Milestone 2 — Preserve ALL tool results for multi-tool queries', () => {

  it('retains every successful tool result, evidence, confidence, and ordering', async () => {
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/vqa') return VQA_RESULT;
      if (endpoint === '/caption') return CAPTION_RESULT;
      return null;
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'What is visible in this image?', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');

    // tool ordering preserved
    expect(res.body.toolResults.map(t => t.tool)).toEqual(['vqa', 'caption']);

    // per-tool results, evidence, confidence retained
    const vqaEntry = res.body.toolResults[0];
    const captionEntry = res.body.toolResults[1];
    expect(vqaEntry.status).toBe('success');
    expect(vqaEntry.result).toEqual(VQA_RESULT.result);
    expect(vqaEntry.evidence).toEqual(VQA_RESULT.evidence);
    expect(vqaEntry.confidence).toBe(0.9);
    expect(captionEntry.status).toBe('success');
    expect(captionEntry.result).toEqual(CAPTION_RESULT.result);
    expect(captionEntry.evidence).toEqual(CAPTION_RESULT.evidence);
    expect(captionEntry.confidence).toBe(0.88);

    // backward-compatible result field still holds the first successful tool
    expect(res.body.result).toEqual(VQA_RESULT.result);

    // persisted with full toolResults
    const stored = await Query.findById(res.body._id);
    expect(stored.toolResults).toHaveLength(2);
    expect(stored.toolResults.map(t => t.tool)).toEqual(['vqa', 'caption']);
    expect(stored.toolResults[1].result).toEqual(CAPTION_RESULT.result);
    expect(stored.toolResults[0].evidence).toEqual(VQA_RESULT.evidence);
    expect(stored.result).toEqual(VQA_RESULT.result);
  });

  it('persists failed tool results (with per-tool error) alongside successes', async () => {
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/vqa') return VQA_RESULT;
      if (endpoint === '/caption') {
        return { tool: 'caption', status: 'failed', result: { error: 'caption model unavailable' }, confidence: 0 };
      }
      return null;
    });

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'What is visible in this image?', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('partial');

    expect(res.body.toolResults).toHaveLength(2);
    const failed = res.body.toolResults.find(t => t.tool === 'caption');
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('caption model unavailable');
    expect(failed.result).toEqual({});

    // success entry still retains its per-tool result and evidence
    const success = res.body.toolResults.find(t => t.tool === 'vqa');
    expect(success.result).toEqual(VQA_RESULT.result);
    expect(success.evidence).toEqual(VQA_RESULT.evidence);

    // result field still backward-compatible (first successful tool)
    expect(res.body.result).toEqual(VQA_RESULT.result);

    // persisted
    const stored = await Query.findById(res.body._id);
    expect(stored.status).toBe('partial');
    expect(stored.toolResults).toHaveLength(2);
    const storedFailed = stored.toolResults.find(t => t.tool === 'caption');
    expect(storedFailed.status).toBe('failed');
    expect(storedFailed.error).toContain('caption model unavailable');
  });

  it('retains all failure details when every tool fails', async () => {
    mockCallMlService.mockImplementation(async () => ({
      status: 'error',
      error: 'GPU OOM across all tools'
    }));

    const tile = await createTile();
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'What is visible in this image?', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.toolResults).toHaveLength(2);
    for (const t of res.body.toolResults) {
      expect(t.status).toBe('failed');
      expect(t.error).toContain('GPU OOM');
    }

    const stored = await Query.findById(res.body._id);
    expect(stored.toolResults).toHaveLength(2);
    expect(stored.toolResults.every(t => t.status === 'failed')).toBe(true);
  });

  it('exposes full toolResults via GET /api/query/:id', async () => {
    mockCallMlService.mockImplementation(async (endpoint) => {
      if (endpoint === '/vqa') return VQA_RESULT;
      if (endpoint === '/caption') return CAPTION_RESULT;
      return null;
    });

    const tile = await createTile();
    const postRes = await request(app)
      .post('/api/query')
      .send({ queryText: 'What is visible in this image?', imageRefs: [String(tile._id)] });

    const getRes = await request(app).get(`/api/query/${postRes.body._id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.toolResults).toHaveLength(2);
    expect(Array.isArray(getRes.body.executionTrace)).toBe(true);
    expect(getRes.body.executionTrace.length).toBeGreaterThan(0);
  });
});