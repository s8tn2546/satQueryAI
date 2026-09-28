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
const { reconcileStaleJobs } = await import('../src/services/queryJobQueue.js');
const { default: Tile } = await import('../src/models/Tile.js');
const { default: QueryJob } = await import('../src/models/QueryJob.js');
const { default: Query } = await import('../src/models/Query.js');
const { default: User } = await import('../src/models/User.js');

let mongoServer;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeGate() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

const MOCK_NDVI = {
  tool: 'ndvi',
  status: 'success',
  result: { mean_ndvi: 0.65, vegetation_coverage: 0.72 },
  evidence: { image: 'tile-1', region: {} },
  confidence: 0.88,
  metadata: {}
};

const QUERY_BODY = {
  queryText: 'Calculate the vegetation index for this image',
  imageRefs: []
};

async function waitForStatus(jobId, desired, authorization) {
  let last;
  for (let i = 0; i < 240; i += 1) {
    const req = request(app).get(`/api/query/status/${jobId}`);
    if (authorization) req.set('Authorization', authorization);
    last = await req;
    if (desired.includes(last.body.jobStatus)) {
      return last;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for jobStatus ${desired.join('/')}; last=${JSON.stringify(last?.body)}`);
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-jwt-secret-for-async';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await seedTools();
});

afterAll(async () => {
  delete process.env.JWT_SECRET;
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockCallMlService.mockResolvedValue(MOCK_NDVI);
  await QueryJob.deleteMany({});
  await Query.deleteMany({});
  await Tile.deleteMany({});
});

async function createTile(modality = 'optical') {
  return Tile.create({
    filename: 'test-ndvi.tif',
    filePath: '/tmp/test-ndvi.tif',
    format: 'geotiff',
    modality
  });
}

describe('Async Query Execution (Phase 19)', () => {
  describe('Synchronous path preserved', () => {
    test('sync POST /api/query still returns the full 200 contract', async () => {
      const tile = await createTile();
      const res = await request(app)
        .post('/api/query')
        .send({ ...QUERY_BODY, imageRefs: [tile._id.toString()] });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('answerText');
      expect(res.body).toHaveProperty('taskType', 'NDVI');
      expect(res.body).toHaveProperty('result', { mean_ndvi: 0.65, vegetation_coverage: 0.72 });
      expect(res.body.confidence).toBeGreaterThanOrEqual(0);
      expect(res.body.confidence).toBeLessThanOrEqual(1);
      expect(res.body).toHaveProperty('executionTrace');
      expect(res.body).toHaveProperty('status');
      expect(mockCallMlService).toHaveBeenCalledWith(expect.stringContaining('/ndvi'), expect.any(Object));
    });

    test('sync validation contract is unchanged (400 rejected, same shape)', async () => {
      const res = await request(app).post('/api/query').send({ queryText: '   ' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        answerText: 'Query text is required.',
        taskType: 'VQA',
        result: {},
        confidence: 0,
        status: 'rejected'
      });
    });
  });

  describe('Async submission', () => {
    test('async POST returns 202 immediately and does not block on the ML service', async () => {
      const tile = await createTile();
      const gate = makeGate();
      mockCallMlService.mockImplementation(() => gate.promise.then(() => MOCK_NDVI));

      const start = Date.now();
      const res = await request(app)
        .post('/api/query?async=true')
        .send({ ...QUERY_BODY, imageRefs: [tile._id.toString()] });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty('jobId');
      expect(res.body.jobStatus).toBe('queued');
      expect(res.body.stage).toBe('queued');
      // The ML call (ther gated long-running work) is still pending: the quick
      // 202 proves accepted, not executed.
      expect(elapsed).toBeLessThan(500);

      gate.resolve();
      const done = await waitForStatus(res.body.jobId, ['completed', 'failed']);
      expect(done.body.jobStatus).toBe('completed');
    });

    test('async POST rejects an empty query with the same 400 contract and creates no job', async () => {
      const res = await request(app).post('/api/query?async=true').send({ queryText: '' });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('rejected');
      expect(await QueryJob.countDocuments()).toBe(0);
    });

    test('async POST rejects malformed imageRefs with 400 and creates no job', async () => {
      const res = await request(app)
        .post('/api/query?async=true')
        .send({ ...QUERY_BODY, imageRefs: ['not-an-objectid'] });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('rejected');
      expect(await QueryJob.countDocuments()).toBe(0);
    });

    test('ordinary POST without async flag is unaffected', async () => {
      const tile = await createTile();
      const res = await request(app)
        .post('/api/query')
        .send({ ...QUERY_BODY, imageRefs: [tile._id.toString()] });
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('jobId');
      expect(await QueryJob.countDocuments()).toBe(0);
    });
  });

  describe('Job status polling', () => {
    test('running jobs report an explicit real stage (no fake percentages)', async () => {
      const tile = await createTile();
      const gate = makeGate();
      mockCallMlService.mockImplementation(() => gate.promise.then(() => MOCK_NDVI));

      const created = await request(app)
        .post('/api/query?async=true')
        .send({ ...QUERY_BODY, imageRefs: [tile._id.toString()] });

      const running = await waitForStatus(created.body.jobId, ['running', 'completed']);
      expect(['running', 'completed']).toContain(running.body.jobStatus);
      expect(running.body.jobId).toBe(created.body.jobId);
      expect(running.body.progress).toBeUndefined();
      expect(running.body.percentage).toBeUndefined();
      if (running.body.jobStatus === 'running') {
        expect(running.body.stage).toMatch(/^(queued|acquiring_data|validating|planning|running_analysis|generating_answer)$/);
        expect(running.body.startedAt).toBeTruthy();
      }

      gate.resolve();
      await waitForStatus(created.body.jobId, ['completed']);
    });

    test('completed jobs serve the identical synchronous result contract', async () => {
      const tile = await createTile();
      const created = await request(app)
        .post('/api/query?async=true')
        .send({ ...QUERY_BODY, imageRefs: [tile._id.toString()] });

      const done = await waitForStatus(created.body.jobId, ['completed']);
      expect(done.body.jobStatus).toBe('completed');
      expect(done.body.stage).toBe('completed');
      expect(done.body.queryId).toBeTruthy();

      // Sync result contract fields, byte-for-byte as /api/query would return.
      expect(done.body.answerText).toEqual(expect.any(String));
      expect(done.body.taskType).toBe('NDVI');
      expect(done.body.result).toEqual({ mean_ndvi: 0.65, vegetation_coverage: 0.72 });
      expect(done.body.confidence).toBeGreaterThanOrEqual(0);
      expect(done.body.confidence).toBeLessThanOrEqual(1);
      expect(done.body.status).toBe('success');
      expect(done.body.executionTrace).toEqual(expect.any(Array));
      expect(Array.isArray(done.body.executionTrace)).toBe(true);

      // The async job persisted a Query document just like the sync path.
      const queryDocRes = await request(app).get(`/api/query/${done.body.queryId}`);
      expect(queryDocRes.status).toBe(200);
      expect(queryDocRes.body._id).toBe(done.body.queryId);
      expect(queryDocRes.body.status).toBe('success');
    });

    test('async completed result matches a synchronous run under identical inputs', async () => {
      const tile = await createTile();
      const body = { ...QUERY_BODY, imageRefs: [tile._id.toString()] };

      const syncRes = await request(app).post('/api/query').send(body);
      const created = await request(app).post('/api/query?async=true').send(body);
      const asyncRes = await waitForStatus(created.body.jobId, ['completed']);

      expect(asyncRes.body.jobStatus).toBe('completed');
      expect(asyncRes.body.answerText).toBe(syncRes.body.answerText);
      expect(asyncRes.body.taskType).toBe(syncRes.body.taskType);
      expect(asyncRes.body.confidence).toBe(syncRes.body.confidence);
      expect(asyncRes.body.status).toBe(syncRes.body.status);
      expect(asyncRes.body.result).toEqual(syncRes.body.result);
      expect(asyncRes.body.evidence).toEqual(syncRes.body.evidence);
    });

    test('unknown jobId returns 404 with the repository error contract', async () => {
      const res = await request(app).get('/api/query/status/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ status: 'failed', error: 'Job not found' });
    });

    test('GET /api/query/status without a jobId still falls through to /:id cleanly', async () => {
      const res = await request(app).get('/api/query/status');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid query id/i);
    });

    test('ML failures complete the job honestly with a failed status, never a fabricated success', async () => {
      const tile = await createTile();
      mockCallMlService.mockRejectedValue(new Error('ML service exploded'));

      const created = await request(app)
        .post('/api/query?async=true')
        .send({ ...QUERY_BODY, imageRefs: [tile._id.toString()] });

      const done = await waitForStatus(created.body.jobId, ['completed', 'failed']);
      expect(done.body.jobStatus).toBe('completed');
      expect(done.body.status).toBe('failed');
      expect(done.body.answerText).toMatch(/^Unable to process your request:/);
      expect(done.body.result).toEqual({});
      expect(done.body.confidence).toBe(0);
      const failedTrace = (done.body.executionTrace || []).find(e => e.step === 'failed');
      expect(failedTrace).toBeTruthy();
    });
  });

  describe('Worker behavior', () => {
    test('concurrency is bounded: second job stays queued while the first is running', async () => {
      const tile = await createTile();
      const gate = makeGate();
      mockCallMlService.mockImplementation(() => gate.promise.then(() => MOCK_NDVI));
      process.env.QUERY_JOB_CONCURRENCY = '1';

      try {
        const a = await request(app)
          .post('/api/query?async=true')
          .send({ ...QUERY_BODY, imageRefs: [tile._id.toString()] });
        const b = await request(app)
          .post('/api/query?async=true')
          .send({ ...QUERY_BODY, imageRefs: [tile._id.toString()] });

        const runningA = await waitForStatus(a.body.jobId, ['running', 'completed']);
        expect(['running', 'completed']).toContain(runningA.body.jobStatus);
        const bStatus = await request(app).get(`/api/query/status/${b.body.jobId}`);
        expect(['queued', 'running', 'completed']).toContain(bStatus.body.jobStatus);
        // At most one ML call may be in flight (bounded worker).
        expect(mockCallMlService.mock.calls.length).toBeLessThanOrEqual(1);

        gate.resolve();
        await waitForStatus(a.body.jobId, ['completed']);
        await waitForStatus(b.body.jobId, ['completed']);
        expect(mockCallMlService.mock.calls.length).toBe(2);
      } finally {
        delete process.env.QUERY_JOB_CONCURRENCY;
        gate.resolve();
      }
    });

    test('restart recovery marks stale queued/running jobs failed without re-executing them', async () => {
      // A job left running by a previous process.
      const stale = await QueryJob.create({
        jobId: 'stale-running-job',
        queryText: 'old',
        imageRefs: [],
        parameters: {},
        status: 'running',
        stage: 'running_analysis',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });
      const staleQueued = await QueryJob.create({
        jobId: 'stale-queued-job',
        queryText: 'old',
        imageRefs: [],
        parameters: {},
        status: 'queued',
        stage: 'queued',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });

      const before = mockCallMlService.mock.calls.length;
      const { modifiedCount } = await reconcileStaleJobs();
      expect(modifiedCount).toBe(2);

      const afterRunning = await QueryJob.findById(stale._id);
      expect(afterRunning.status).toBe('failed');
      expect(afterRunning.stage).toBe('failed');
      expect(afterRunning.error).toMatch(/restarted/i);
      expect(afterRunning.response).toBeNull();

      const afterQueued = await QueryJob.findById(staleQueued._id);
      expect(afterQueued.status).toBe('failed');

      // Stale jobs are never re-executed by the recovery pass.
      expect(mockCallMlService.mock.calls.length).toBe(before);

      // A job enqueued after recovery is not mislabeled and still runs.
      const tile = await createTile();
      const created = await request(app)
        .post('/api/query?async=true')
        .send({ ...QUERY_BODY, imageRefs: [tile._id.toString()] });
      const done = await waitForStatus(created.body.jobId, ['completed']);
      expect(done.body.jobStatus).toBe('completed');
      expect(done.body.status).toBe('success');
    });

    test('job-level failure renders explicitly via the status endpoint', async () => {
      const jobId = 'explicit-failed-job';
      await QueryJob.create({
        jobId,
        queryText: 'old',
        imageRefs: [],
        parameters: {},
        status: 'failed',
        stage: 'failed',
        error: 'Backend restarted before this job completed.',
        startedAt: new Date(Date.now() - 1000),
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });

      const res = await request(app).get(`/api/query/status/${jobId}`);
      expect(res.status).toBe(200);
      expect(res.body.jobStatus).toBe('failed');
      expect(res.body.error).toMatch(/restarted/i);
      expect(res.body.answerText).toBeUndefined();
      expect(res.body.status).toBeUndefined();
    });
  });

  describe('Ownership and lifecycle', () => {
    test('authenticated jobs are only pollable by their owner', async () => {
      const tile = await createTile();
      const alice = await User.create({ name: 'Alice', email: 'alice@example.com', passwordHash: 'x' });
      const bob = await User.create({ name: 'Bob', email: 'bob@example.com', passwordHash: 'x' });
      const secret = process.env.JWT_SECRET;
      const aliceToken = jwt.sign({ userId: alice._id.toString() }, secret);
      const bobToken = jwt.sign({ userId: bob._id.toString() }, secret);

      const created = await request(app)
        .post('/api/query?async=true')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ ...QUERY_BODY, imageRefs: [tile._id.toString()] });
      expect(created.status).toBe(202);

      const anonymousRes = await request(app).get(`/api/query/status/${created.body.jobId}`);
      expect(anonymousRes.status).toBe(404);

      const bobRes = await request(app)
        .get(`/api/query/status/${created.body.jobId}`)
        .set('Authorization', `Bearer ${bobToken}`);
      expect(bobRes.status).toBe(404);

      const ownerRes = await request(app)
        .get(`/api/query/status/${created.body.jobId}`)
        .set('Authorization', `Bearer ${aliceToken}`);
      expect(ownerRes.status).toBe(200);
      expect(ownerRes.body.jobId).toBe(created.body.jobId);
      await waitForStatus(created.body.jobId, ['completed'], `Bearer ${aliceToken}`);
    });

    test('anonymous jobs follow the repository convention (possession of jobId is the credential)', async () => {
      const tile = await createTile();
      const created = await request(app)
        .post('/api/query?async=true')
        .send({ ...QUERY_BODY, imageRefs: [tile._id.toString()] });

      const res = await request(app).get(`/api/query/status/${created.body.jobId}`);
      expect(res.status).toBe(200);
      expect(res.body.jobId).toBe(created.body.jobId);
      await waitForStatus(created.body.jobId, ['completed']);
    });

    test('health endpoint stays responsive while an async job is in flight', async () => {
      const tile = await createTile();
      const gate = makeGate();
      mockCallMlService.mockImplementation(() => gate.promise.then(() => MOCK_NDVI));

      const created = await request(app)
        .post('/api/query?async=true')
        .send({ ...QUERY_BODY, imageRefs: [tile._id.toString()] });

      await waitForStatus(created.body.jobId, ['running', 'completed']);
      const health = await request(app).get('/health');
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: 'ok', service: 'satquery-backend' });

      gate.resolve();
      await waitForStatus(created.body.jobId, ['completed']);
    });

    test('job documents carry a bounded TTL retention expiry in the future', async () => {
      const tile = await createTile();
      const created = await request(app)
        .post('/api/query?async=true')
        .send({ ...QUERY_BODY, imageRefs: [tile._id.toString()] });

      const doc = await QueryJob.findOne({ jobId: created.body.jobId });
      expect(doc).toBeTruthy();
      expect(doc.expiresAt.getTime()).toBeGreaterThan(Date.now());
      const ttlHours = (doc.expiresAt.getTime() - Date.now()) / (60 * 60 * 1000);
      expect(ttlHours).toBeGreaterThan(20);
      expect(ttlHours).toBeLessThanOrEqual(25);

      // Drain the background job before teardown disconnects Mongo.
      await waitForStatus(created.body.jobId, ['completed']);
    });
  });
});