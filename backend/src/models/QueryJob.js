import mongoose from 'mongoose';

const QUERY_JOB_STATUSES = ['queued', 'running', 'completed', 'failed'];

const queryJobSchema = new mongoose.Schema({
  // Opaque client-facing id (UUID) kept stable across restarts. Distinct from
  // the persisted Query document id so the job lifecycle never touches the
  // Query history contract (statuses success/partial/failed/rejected).
  jobId: { type: String, required: true, unique: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  sessionId: { type: String, default: null },
  queryText: { type: String, required: true },
  imageRefs: { type: [String], default: [] },
  parameters: { type: Object, default: {} },
  status: { type: String, enum: QUERY_JOB_STATUSES, default: 'queued', index: true },
  // Latest real pipeline stage (acquiring_data/validating/planning/
  // running_analysis/generating_answer/completed). Freely strided so the
  // pipeline can grow stages without a schema migration.
  stage: { type: String, default: 'queued' },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  queryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Query', default: null },
  // The exact response object the synchronous path returns, embedded verbatim
  // so a completed job byte-matches GET /api/query/status output with a sync
  // execution under the same conditions.
  response: { type: Object, default: null },
  error: { type: String, default: null },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

queryJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
queryJobSchema.index({ status: 1, createdAt: 1 });

export const QueryJob = mongoose.model('QueryJob', queryJobSchema);
export default QueryJob;