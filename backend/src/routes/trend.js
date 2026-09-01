import express from 'express';
import ResultsCache from '../models/ResultsCache.js';
import mlServiceClient from '../services/mlServiceClient.js';
import crypto from 'crypto';

const router = express.Router();

const CACHE_TTL_DAYS = 7;

function hashParameters(params) {
  return crypto.createHash('sha256').update(JSON.stringify(params)).digest('hex');
}

router.post('/', async (req, res) => {
  try {
    const { metric, region, startDate, endDate } = req.body;

    if (!metric || !region || !startDate || !endDate) {
      return res.status(400).json({
        status: 'failed',
        error: 'Missing required parameters: metric, region, startDate, endDate'
      });
    }

    const cacheParams = { metric, region, startDate, endDate };
    const paramHash = hashParameters(cacheParams);

    const cached = await ResultsCache.findOne({
      tool: 'trend',
      'parameters.hash': paramHash,
      expiresAt: { $gt: new Date() }
    });

    if (cached) {
      return res.status(200).json({
        tool: 'trend',
        status: 'success',
        result: cached.result,
        evidence: cached.evidence,
        confidence: cached.confidence,
        metadata: {
          ...cached.metadata,
          source: 'cache',
          cachedAt: cached.createdAt
        }
      });
    }

    const mlResult = await mlServiceClient.callMlService('/trend', {
      metric,
      region,
      start_date: startDate,
      end_date: endDate
    });

    if (mlResult.status === 'success' && mlResult.result) {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS);

      await ResultsCache.create({
        tool: 'trend',
        parameters: { ...cacheParams, hash: paramHash },
        result: mlResult.result,
        evidence: mlResult.evidence || {},
        confidence: mlResult.confidence || 0,
        metadata: mlResult.metadata || {},
        expiresAt
      });
    }

    return res.status(200).json(mlResult);
  } catch (error) {
    console.error('[Trend] Error:', error);
    return res.status(500).json({
      tool: 'trend',
      status: 'failed',
      result: {},
      error: error.message,
      confidence: 0
    });
  }
});

export default router;
