import express from 'express';
import Query from '../models/Query.js';
import { runAgentPipeline } from '../agents/pipeline.js';

const router = express.Router();

/**
 * POST /api/query
 * Main entry point: { queryText, imageRefs: [tileId, ...] }
 * Returns structured response per Section 6 contract.
 */
router.post('/', async (req, res) => {
  try {
    const { queryText, imageRefs = [], parameters = {} } = req.body;

    if (!queryText || typeof queryText !== 'string' || queryText.trim() === '') {
      return res.status(400).json({
        answerText: 'Query text is required.',
        taskType: 'VQA',
        result: {},
        evidence: { images: [], region: {}, notes: 'Validation failure: empty queryText' },
        confidence: 0,
        executionTrace: [{ step: 'input_validation', detail: 'Query text was missing or empty', timestamp: new Date().toISOString() }],
        status: 'rejected'
      });
    }

    const response = await runAgentPipeline(queryText.trim(), imageRefs, parameters);
    return res.status(200).json(response);
  } catch (error) {
    console.error('[Query] Pipeline error:', error);
    return res.status(500).json({
      answerText: 'An internal server error occurred while processing the query.',
      taskType: 'VQA',
      result: {},
      evidence: { images: [], region: {}, notes: error.message },
      confidence: 0,
      executionTrace: [{ step: 'error', detail: error.message, timestamp: new Date().toISOString() }],
      status: 'failed'
    });
  }
});

/**
 * GET /api/query/history
 */
router.get('/history', async (req, res) => {
  try {
    const queries = await Query.find().sort({ createdAt: -1 }).limit(50);
    return res.status(200).json(queries);
  } catch (error) {
    return res.status(500).json({ status: 'failed', error: error.message });
  }
});

/**
 * GET /api/query/:id/report
 */
router.get('/:id/report', async (req, res) => {
  try {
    const queryDoc = await Query.findById(req.params.id);
    if (!queryDoc) {
      return res.status(404).json({ status: 'failed', error: 'Query not found' });
    }
    const report = {
      queryId: queryDoc._id,
      queryText: queryDoc.queryText,
      answerText: queryDoc.answerText,
      taskType: queryDoc.taskType,
      status: queryDoc.status,
      confidence: queryDoc.confidence,
      evidence: queryDoc.evidence,
      result: queryDoc.result,
      executionTrace: queryDoc.executionTrace,
      generatedAt: new Date().toISOString()
    };
    return res.status(200).json(report);
  } catch (error) {
    return res.status(500).json({ status: 'failed', error: error.message });
  }
});

/**
 * GET /api/query/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const queryDoc = await Query.findById(req.params.id);
    if (!queryDoc) {
      return res.status(404).json({ status: 'failed', error: 'Query not found' });
    }
    return res.status(200).json(queryDoc);
  } catch (error) {
    return res.status(500).json({ status: 'failed', error: error.message });
  }
});

export default router;
