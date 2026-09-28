import { randomUUID } from 'node:crypto';
import QueryJob from '../models/QueryJob.js';
import { executeQueryRequest } from './queryExecution.js';

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TTL_HOURS = 24;

function parsedConcurrency() {
  const raw = Number.parseInt(process.env.QUERY_JOB_CONCURRENCY, 10);
  return Number.isFinite(raw) ? Math.min(4, Math.max(1, raw)) : DEFAULT_CONCURRENCY;
}

function parsedTtlHours() {
  const raw = Number.parseInt(process.env.QUERY_JOB_TTL_HOURS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_HOURS;
}

export function jobTtlHours() {
  return parsedTtlHours();
}

export function jobConcurrency() {
  return parsedConcurrency();
}

export function safeJobError(err) {
  const raw = err?.message || String(err || 'An internal error occurred while processing the job.');
  const firstLine = String(raw).split('\n')[0].trim();
  return firstLine ? firstLine.slice(0, 250) : 'An internal error occurred while processing the job.';
}

/**
 * In-process bounded FIFO worker. Jobs are persisted in Mongo (QueryJob), so
 * status is durable; only the pending/in-flight scheduling state lives in this
 * module's memory. Restart recovery is provided by reconcileStaleJobs(): any
 * job left queued/running by a previous process is marked failed, never
 * silently re-executed.
 */

const pendingJobIds = [];
let activeWorkers = 0;

function pump() {
  while (activeWorkers < parsedConcurrency() && pendingJobIds.length > 0) {
    const jobId = pendingJobIds.shift();
    activeWorkers += 1;
    runJob(jobId)
      .catch(err => console.error('[QueryJobQueue] Unhandled worker error:', err))
      .finally(() => {
        activeWorkers -= 1;
        pump();
      });
  }
}

async function runJob(jobId) {
  const startedAt = new Date();
  const job = await QueryJob.findOneAndUpdate(
    { jobId, status: 'queued' },
    { $set: { status: 'running', stage: 'queued', startedAt, error: null } },
    { new: true }
  );

  if (!job) {
    // A concurrent recovery pass already disposed of this job; nothing to do.
    return;
  }

  try {
    const result = await executeQueryRequest(
      {
        queryText: job.queryText,
        imageRefs: job.imageRefs,
        parameters: job.parameters || {},
        // Absent session ids are stored as null; re-present them to the shared
        // validator as "absent" (undefined) so the worker never sees a value
        // the route-time contract would have rejected.
        sessionId: job.sessionId || undefined
      },
      {
        stageSink: stage => {
          QueryJob.updateOne({ jobId }, { $set: { stage } }).catch(err =>
            console.error('[QueryJobQueue] Stage update failed:', err?.message || err)
          );
        }
      }
    );

    if (!result.ok) {
      // Unreachable in practice: enqueue only persists already-validated
      // values. Guard anyway so an invariant break surfaces as an explicit
      // job failure instead of a fabricated success.
      throw new Error(`Query request rejected with HTTP ${result.httpStatus} after enqueue (validation drift).`);
    }

    await QueryJob.findOneAndUpdate(
      { jobId, status: 'running' },
      {
        $set: {
          status: 'completed',
          stage: 'completed',
          response: result.response,
          queryId: result.response?._id || null,
          completedAt: new Date()
        },
        $unset: { error: 1 }
      }
    );
  } catch (err) {
    console.error('[QueryJobQueue] Execution failed for', jobId, err);
    await QueryJob.findOneAndUpdate(
      { jobId, status: 'running' },
      {
        $set: { status: 'failed', stage: 'failed', error: safeJobError(err), completedAt: new Date() }
      }
    );
  }
}

export async function enqueueQueryJob({ queryText, imageRefs, parameters, sessionId, userId = null }) {
  const jobId = randomUUID();
  const expiresAt = new Date(Date.now() + parsedTtlHours() * 60 * 60 * 1000);
  await QueryJob.create({
    jobId,
    userId: userId || null,
    sessionId: sessionId ?? null,
    queryText,
    imageRefs: imageRefs || [],
    parameters: parameters || {},
    status: 'queued',
    stage: 'queued',
    expiresAt
  });
  pendingJobIds.push(jobId);
  pump();
  return { jobId, createdAt: new Date() };
}

/**
 * Marks every job left queued/running by a previous process as failed. Called
 * once at startup (index.js) after the DB connection is established. Deliberately
 * NOT invoked lazily inside pump/enqueue: that could mislabel a freshly enqueued
 * job as stale in single-process runs.
 */
export async function reconcileStaleJobs({ now = new Date() } = {}) {
  const result = await QueryJob.updateMany(
    { status: { $in: ['queued', 'running'] } },
    {
      $set: {
        status: 'failed',
        stage: 'failed',
        error: 'Backend restarted before this job completed.',
        completedAt: now
      },
      $unset: { response: 1 }
    }
  );
  return result;
}