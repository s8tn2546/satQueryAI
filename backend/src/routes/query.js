import express from 'express';
import Query from '../models/Query.js';

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

    const stubResponse = {
      answerText: `Stub answer for query: "${queryText}". The satellite image indicates mixed land cover with urban infrastructure and vegetation features.`,
      taskType: 'VQA',
      result: {
        answer: `Analysis complete for: ${queryText}`,
        confidence: 0.95
      },
      evidence: {
        images: imageRefs,
        region: parameters.region || {},
        notes: 'Initial stub response unblocking frontend integration.'
      },
      confidence: 0.95,
      executionTrace: [
        { step: 'intent_classification', detail: 'Classified task as VQA', timestamp: new Date().toISOString() },
        { step: 'input_validation', detail: 'Inputs validated successfully', timestamp: new Date().toISOString() },
        { step: 'tool_execution', detail: 'Executed stub tool', timestamp: new Date().toISOString() }
      ],
      status: 'success'
    };

    // Save stub query doc to DB
    const queryDoc = await Query.create({
      queryText,
      inputRefs: imageRefs,
      taskType: stubResponse.taskType,
      toolsInvoked: ['vqa'],
      parameters,
      result: stubResponse.result,
      evidence: stubResponse.evidence,
      confidence: stubResponse.confidence,
      executionTrace: stubResponse.executionTrace,
      answerText: stubResponse.answerText,
      status: stubResponse.status
    });

    return res.status(200).json({
      _id: queryDoc._id,
      ...stubResponse
    });
  } catch (error) {
    console.error('[Query Stub] Error processing query:', error);
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
