/**
 * Phase 20 — API hardening regression tests.
 *
 * Coverage: CORS allowlist, security headers, 404/error-handler shape, bounded
 * JSON bodies, upload filePath non-leak + multi-file rollback, and query
 * ownership (history / :id / :id/report) for authenticated vs anonymous users.
 */

import { jest } from '@jest/globals';

const mockCallMlService = jest.fn();

jest.unstable_mockModule('../src/services/mlServiceClient.js', () => ({
  default: { callMlService: mockCallMlService }
}));

const { MongoMemoryServer } = await import('mongodb-memory-server');
const mongoose = (await import('mongoose')).default;
const jwt = (await import('jsonwebtoken')).default;
const request = (await import('supertest')).default;
const { default: app } = await import('../src/index.js');
const { seedTools } = await import('../src/services/seedTools.js');
const { default: Tile } = await import('../src/models/Tile.js');
const { default: Query } = await import('../src/models/Query.js');
const { default: User } = await import('../src/models/User.js');

let mongod;

const TEST_SECRET = 'test-jwt-secret-for-phase20';

// A real, decodable 1x1 PNG (same fixture as upload-integrity).
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const CORRUPT_PNG = Buffer.concat([VALID_PNG.subarray(0, 8), Buffer.alloc(64, 0xde)]);

function validVerdict(overrides = {}) {
  return {
    tool: 'validate',
    status: 'success',
    confidence: 1,
    result: { valid: true, validation_status: 'valid', errors: [], warnings: [], ...overrides },
    evidence: { filename: 'test.png' }
  };
}

const MOCK_NDVI = {
  tool: 'ndvi',
  status: 'success',
  result: { mean_ndvi: 0.65, vegetation_coverage: 0.72 },
  evidence: { image: 'tile-1', region: {} },
  confidence: 0.88,
  metadata: {}
};

async function signToken(userId) {
  return jwt.sign({ userId: String(userId) }, TEST_SECRET);
}

beforeAll(async () => {
  process.env.JWT_SECRET = TEST_SECRET;
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seedTools();
});

afterAll(async () => {
  delete process.env.JWT_SECRET;
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockCallMlService.mockResolvedValue(MOCK_NDVI);
  await Tile.deleteMany({});
  await Query.deleteMany({});
  await User.deleteMany({});
});

describe('security headers and CORS', () => {
  it('provides helmet security headers and no x-powered-by', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBeTruthy();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('does not reflect a disallowed origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reflects an allowlisted origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});

describe('route and body-limit hardening', () => {
  it('returns a JSON 404 for unknown routes (never HTML)', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({ status: 'failed', error: 'Route not found.' });
  });

  it('rejects an oversized JSON body with a JSON 413', async () => {
    const res = await request(app)
      .post('/api/query')
      .set('Content-Type', 'application/json')
      .send({ queryText: 'x'.repeat(3 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.status).toBe('failed');
  });
});

describe('upload hardening', () => {
  it('never leaks the on-disk filePath in the upload response', async () => {
    mockCallMlService.mockResolvedValue(validVerdict({ is_georeferenced: true }));
    const res = await request(app)
      .post('/api/images/upload')
      .field('modality', 'optical')
      .attach('images', VALID_PNG, 'test.png');

    expect(res.status).toBe(200);
    expect(res.body.tiles).toHaveLength(1);
    expect(res.body.tiles[0].filePath).toBeUndefined();
    expect(res.body.tiles[0].storedFile).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/images-[a-z0-9]+-[0-9]+\.png/);
  });

  it('rolls back previously-persisted tiles when a later file rejects (multi-file upload)', async () => {
    mockCallMlService
      .mockResolvedValueOnce(validVerdict({ is_georeferenced: true }))
      .mockResolvedValueOnce({
        tool: 'validate',
        status: 'success',
        confidence: 1,
        result: { valid: false, validation_status: 'invalid', errors: ['Not a readable raster.'], warnings: [] }
      });

    const res = await request(app)
      .post('/api/images/upload')
      .field('modality', 'optical')
      .attach('images', VALID_PNG, 'ok.png')
      .attach('images', CORRUPT_PNG, 'bad.png');

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('rejected');
    // No orphan tile may survive referencing a now-deleted file.
    expect(await Tile.countDocuments()).toBe(0);
  });
});

describe('query ownership', () => {
  let aliceToken;
  let bobToken;

  beforeEach(async () => {
    const alice = await User.create({ name: 'Alice', email: 'a@example.com', passwordHash: 'x' });
    const bob = await User.create({ name: 'Bob', email: 'b@example.com', passwordHash: 'x' });
    aliceToken = await signToken(alice._id);
    bobToken = await signToken(bob._id);
  });

  it('anonymous history lookup without sessionId is rejected (no cross-tenant dump)', async () => {
    const res = await request(app).get('/api/query/history');
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('rejected');
  });

  it('authenticated users only ever see their own history', async () => {
    const res = await request(app)
      .post('/api/query')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ queryText: 'Calculate NDVI', imageRefs: [] });
    expect(res.status).toBe(200);

    const aliceHistory = await request(app)
      .get('/api/query/history')
      .set('Authorization', `Bearer ${aliceToken}`);
    expect(aliceHistory.status).toBe(200);
    expect(aliceHistory.body).toHaveLength(1);

    const bobHistory = await request(app)
      .get('/api/query/history')
      .set('Authorization', `Bearer ${bobToken}`);
    expect(bobHistory.status).toBe(200);
    expect(bobHistory.body).toHaveLength(0);
  });

  it('query and report docs are owner-only once a userId is recorded', async () => {
    const res = await request(app)
      .post('/api/query')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ queryText: 'Calculate NDVI', imageRefs: [] });
    expect(res.status).toBe(200);
    const queryId = res.body._id;

    const owner = await request(app).get(`/api/query/${queryId}`).set('Authorization', `Bearer ${aliceToken}`);
    expect(owner.status).toBe(200);

    // Non-owner may not read the query or its report; existence is not disclosed.
    const bob = await request(app).get(`/api/query/${queryId}`).set('Authorization', `Bearer ${bobToken}`);
    expect(bob.status).toBe(404);

    const anonymous = await request(app).get(`/api/query/${queryId}`);
    expect(anonymous.status).toBe(404);

    const reportOwner = await request(app).get(`/api/query/${queryId}/report`).set('Authorization', `Bearer ${aliceToken}`);
    expect(reportOwner.status).toBe(200);

    const reportBob = await request(app).get(`/api/query/${queryId}/report`).set('Authorization', `Bearer ${bobToken}`);
    expect(reportBob.status).toBe(404);
  });

  it('anonymous-created queries keep the possession-of-id convention', async () => {
    const res = await request(app)
      .post('/api/query')
      .send({ queryText: 'Calculate NDVI', imageRefs: [] });
    expect(res.status).toBe(200);

    const anon = await request(app).get(`/api/query/${res.body._id}`);
    expect(anon.status).toBe(200);

    const stored = await Query.findById(res.body._id);
    expect(stored.userId).toBeNull();
  });
});