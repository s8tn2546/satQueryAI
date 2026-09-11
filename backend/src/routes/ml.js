import express from 'express';
import mlServiceClient from '../services/mlServiceClient.js';

const router = express.Router();

/**
 * POST /api/ml/warmup
 * Pre-loads the VLM (base model + LoRA adapter) on the ML service into its
 * in-memory cache so a user's first query does not pay the cold-start cost.
 *
 * Safe to call any time: idempotent on the ML side, serialized here, and
 * skipped automatically while the ML service is busy with a live query (a
 * concurrent warmup + inference caused hangs before). Never fabricates a
 * result — the UI consumes the real/`unavailable`/`skipped` statuses.
 *
 * The client is consumed through its default export (not a named import) so
 * test suites that mock this module with a `default`-only factory keep
 * linking; the call itself is guarded for the same reason.
 */
router.post('/warmup', async (req, res) => {
  try {
    if (typeof mlServiceClient.warmupMl !== 'function') {
      return res.status(200).json({ status: 'unavailable', reason: 'warmup not supported in this build' });
    }
    const result = await mlServiceClient.warmupMl();
    return res.status(200).json(result);
  } catch (error) {
    console.error('[ML] Warmup error:', error);
    return res.status(500).json({ status: 'unavailable', reason: error.message });
  }
});

export default router;