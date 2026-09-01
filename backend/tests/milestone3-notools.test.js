import { jest } from '@jest/globals';

const mockCallMlService = jest.fn();

jest.unstable_mockModule('../src/services/mlServiceClient.js', () => ({
  default: { callMlService: mockCallMlService }
}));

jest.unstable_mockModule('../src/agents/taskPlanner.js', () => ({
  planTools: async () => []
}));

const { MongoMemoryServer } = await import('mongodb-memory-server');
const mongoose = (await import('mongoose')).default;
const request = (await import('supertest')).default;
const { default: app } = await import('../src/index.js');
const { seedTools } = await import('../src/services/seedTools.js');
const { default: Tile } = await import('../src/models/Tile.js');
const { default: Query } = await import('../src/models/Query.js');

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

describe('Milestone 3 — pipeline: no tools executable (empty/unresolvable tool set)', () => {
  it('returns an honest failed response (not a 500 crash)', async () => {
    const tile = await Tile.create({
      source: 'benchmark-upload',
      modality: 'optical',
      format: 'png',
      filePath: '/tmp/fake.png',
      validated: true,
      validationDetails: {}
    });

    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'Describe the scene in this image.', imageRefs: [String(tile._id)] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.confidence).toBe(0);
    expect(res.body.answerText).toMatch(/No tools could be executed/i);
    expect(Array.isArray(res.body.toolResults)).toBe(true);
    expect(res.body.toolResults).toEqual([]);
    expect(mockCallMlService).not.toHaveBeenCalled();

    const stored = await Query.findById(res.body._id);
    expect(stored.status).toBe('failed');
    expect(stored.toolResults).toEqual([]);
  });
});