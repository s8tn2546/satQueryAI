import express from 'express';
import mongoose from 'mongoose';
import Query from '../models/Query.js';
import ResultsCache from '../models/ResultsCache.js';
import mlServiceClient from '../services/mlServiceClient.js';
import { runAgentPipeline } from '../agents/pipeline.js';
import { composeAnswer } from '../agents/answerComposer.js';
import { makeTraceEntry } from '../utils/responseBuilder.js';
import { isDemoRegion, isMockTrendResult, findDemoTrendFallback } from '../services/demoTrendService.js';

const router = express.Router();

const SUPPORTED_TREND_METRICS = new Set(['ndvi', 'ndwi']);
const SUPPORTED_INTERVALS = new Set(['monthly', 'yearly']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function regionKey(region) {
  return JSON.stringify({ type: region.type, coordinates: region.coordinates });
}

function parseIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function validateTrendRequest(body) {
  const { region, metric = 'ndvi', startDate, endDate, interval = 'monthly' } = body || {};

  if (!region || typeof region !== 'object' || !['Polygon', 'MultiPolygon'].includes(region.type) ||
      !Array.isArray(region.coordinates) || region.coordinates.length === 0) {
    return 'region (GeoJSON Polygon or MultiPolygon) is required.';
  }

  const metricLower = String(metric).toLowerCase();
  if (!SUPPORTED_TREND_METRICS.has(metricLower)) {
    return `Unsupported metric "${metric}". Supported: ndvi, ndwi.`;
  }

  if (!SUPPORTED_INTERVALS.has(interval)) {
    return `Unsupported interval "${interval}". Supported: monthly, yearly.`;
  }

  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start) return 'startDate (ISO YYYY-MM-DD) is required and must be a valid date.';
  if (!end) return 'endDate (ISO YYYY-MM-DD) is required and must be a valid date.';
  if (start >= end) return 'endDate must be later than startDate.';

  return null;
}

const TREND_TASK_TYPE = 'TREND';
const CACHE_TTL_DAYS = 7;

function trendFailureResponse(reason, trace = []) {
  return {
    answerText: `Unable to process trend: ${reason}`,
    taskType: TREND_TASK_TYPE,
    result: {},
    evidence: { images: [], region: {}, notes: reason },
    confidence: 0,
    executionTrace: trace,
    status: 'failed'
  };
}

function trendRejectedResponse(reason, trace = []) {
  return {
    answerText: reason,
    taskType: TREND_TASK_TYPE,
    result: {},
    evidence: { images: [], region: {}, notes: reason },
    confidence: 0,
    executionTrace: [...trace, makeTraceEntry('trend_validation_failed', reason)],
    status: 'rejected'
  };
}

async function composeTrendAnswer(result, confidence, trace) {
  const toolResults = [{ tool: 'trend', status: 'success', result: result || {}, confidence: confidence || 0 }];
  return composeAnswer('Historical trend analysis', TREND_TASK_TYPE, toolResults, trace);
}

async function findCoveringCacheEntry({ region, metric, startDate, endDate, interval }) {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  return ResultsCache.findOne({
    metric,
    regionKey: regionKey(region),
    interval,
    'dateRange.start': { $lte: start },
    'dateRange.end': { $gte: end }
  }).sort({ computedAt: -1 });
}

/**
 * POST /api/query
 * Main entry point: { queryText, imageRefs: [tileId, ...] }
 * Returns structured response per Section 6 contract.
 */
router.post('/', async (req, res) => {
  try {
    const { queryText, imageRefs = [], parameters = {}, sessionId } = req.body;

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

    if (sessionId !== undefined && typeof sessionId !== 'string') {
      return res.status(400).json({
        answerText: 'sessionId must be a string.',
        taskType: 'VQA',
        result: {},
        evidence: { images: [], region: {}, notes: 'Validation failure: sessionId is not a string' },
        confidence: 0,
        executionTrace: [{ step: 'input_validation', detail: 'sessionId was not a string', timestamp: new Date().toISOString() }],
        status: 'rejected'
      });
    }

    if (!Array.isArray(imageRefs)) {
      return res.status(400).json({
        answerText: 'imageRefs must be an array of tile IDs.',
        taskType: 'VQA',
        result: {},
        evidence: { images: [], region: {}, notes: 'Validation failure: imageRefs is not an array' },
        confidence: 0,
        executionTrace: [{ step: 'input_validation', detail: 'imageRefs was not an array', timestamp: new Date().toISOString() }],
        status: 'rejected'
      });
    }

    const invalidRefs = imageRefs.filter(ref => !mongoose.isValidObjectId(ref));
    if (invalidRefs.length > 0) {
      return res.status(400).json({
        answerText: `Invalid image reference(s): ${invalidRefs.join(', ')}`,
        taskType: 'VQA',
        result: {},
        evidence: { images: [], region: {}, notes: 'Validation failure: malformed image reference' },
        confidence: 0,
        executionTrace: [{ step: 'input_validation', detail: 'One or more imageRefs were malformed', timestamp: new Date().toISOString() }],
        status: 'rejected'
      });
    }

    const response = await runAgentPipeline(queryText.trim(), imageRefs, parameters, { sessionId });
    return res.status(200).json(response);
  } catch (error) {
    console.error('[Query] Pipeline error:', error);
    return res.status(500).json({
      answerText: 'An internal server error occurred while processing the query.',
      taskType: 'VQA',
      result: {},
      evidence: { images: [], region: {}, notes: 'internal error' },
      confidence: 0,
      executionTrace: [{ step: 'error', detail: 'internal error', timestamp: new Date().toISOString() }],
      status: 'failed'
    });
  }
});

/**
 * POST /api/query/trend
 * Historical trend query: { region, metric, startDate, endDate, interval? }
 * Two-phase cache resolution per BACKEND.md §10:
 *   Phase 1: exact/superset cache match -> return cached result.
 *   Phase 2: cache miss -> call ML /trend, store successful result, return.
 */
router.post('/trend', async (req, res) => {
  try {
    const validationError = validateTrendRequest(req.body);
    if (validationError) {
      return res.status(400).json(trendRejectedResponse(validationError));
    }

    const { region, metric = 'ndvi', startDate, endDate, interval = 'monthly' } = req.body;
    const metricLower = String(metric).toLowerCase();

    const cached = await findCoveringCacheEntry({ region, metric: metricLower, startDate, endDate, interval });
    if (cached) {
      const trace = [
        makeTraceEntry('trend_cache_check', `Cache lookup for ${metricLower} over ${region.type} region`),
        makeTraceEntry('trend_cache_hit', `Using cached result computed ${cached.computedAt.toISOString()}`)
      ];
      const answerText = await composeTrendAnswer(cached.result, cached.confidence, trace);
      const cache = { hit: true, computedAt: cached.computedAt };
      if (cached.metadata?.demoPrecomputed === true) {
        cache.source = 'demo-precompute';
      }
      return res.status(200).json({
        answerText,
        taskType: TREND_TASK_TYPE,
        result: cached.result || {},
        evidence: cached.evidence || { images: [], region: {}, notes: '' },
        confidence: cached.confidence || 0,
        executionTrace: trace,
        status: 'success',
        cache
      });
    }

    const trace = [
      makeTraceEntry('trend_cache_check', `Cache miss for ${metricLower} over ${region.type} region`)
    ];

    const mlResult = await mlServiceClient.callMlService('/trend', {
      region,
      metric: metricLower,
      start_date: startDate,
      end_date: endDate,
      interval
    });

    if (!mlResult || !['success', 'partial'].includes(mlResult.status)) {
      // Precomputed demo-region fallback (BACKEND.md §15.5): only for the exact
      // configured demo region, only when the live ML/GEE request failed, and
      // only when a valid precomputed demo entry exists. Region mismatch or no
      // demo cache preserve the honest failure below.
      const fallback = await findDemoTrendFallback({
        metric: metricLower,
        interval,
        regionKey: regionKey(region)
      });
      if (fallback) {
        const reason = mlResult?.result?.error || mlResult?.error || `ML service returned ${mlResult?.status || 'no status'} for /trend`;
        trace.push(makeTraceEntry('trend_ml_failed', reason));
        trace.push(makeTraceEntry(
          'trend_demo_fallback',
          `Serving precomputed demo-region fallback computed ${fallback.computedAt.toISOString()} covering ${fallback.dateRange?.start?.toISOString().slice(0, 10)}..${fallback.dateRange?.end?.toISOString().slice(0, 10)}`
        ));
        const answerText = await composeTrendAnswer(fallback.result, fallback.confidence, trace);
        const evidence = { ...(fallback.evidence || {}), isDemoPrecompute: true, data_source: 'demo-precompute' };
        return res.status(200).json({
          answerText,
          taskType: TREND_TASK_TYPE,
          result: fallback.result || {},
          evidence,
          confidence: fallback.confidence || 0,
          executionTrace: trace,
          status: 'success',
          cache: { hit: true, source: 'demo-precompute', computedAt: fallback.computedAt },
          fallback: {
            source: 'demo-precompute',
            computedAt: fallback.computedAt.toISOString(),
            dateRange: {
              start: fallback.dateRange?.start?.toISOString().slice(0, 10),
              end: fallback.dateRange?.end?.toISOString().slice(0, 10)
            },
            note: `Live ML /trend failed (${reason}). Serving the precomputed demo-region result.`
          }
        });
      }
      const reason = mlResult?.result?.error || mlResult?.error || `ML service returned ${mlResult?.status || 'no status'} for /trend`;
      trace.push(makeTraceEntry('trend_ml_failed', reason));
      return res.status(200).json(trendFailureResponse(reason, trace));
    }

    const result = mlResult.result || {};
    const confidence = mlResult.confidence || 0;
    const evidence = mlResult.evidence || { images: [], region: {}, notes: '' };

    // A labeled mock/fallback result (ML unreachable, timed out, or GEE-unavailable
    // fixtures) is served to the client but must never be cached as a real result.
    // Shared guard lives in the demo-trend service; mock-labeled results are never
    // treated as real data by either the cache or the demo fallback.
    if (isMockTrendResult(mlResult)) {
      // Prefer the precomputed demo-region fallback over serving a mock-labeled
      // result, but only for the configured demo region with a valid entry.
      const fallback = await findDemoTrendFallback({
        metric: metricLower,
        interval,
        regionKey: regionKey(region)
      });
      if (fallback) {
        const reason = 'ML /trend returned a labeled mock/fallback result';
        trace.push(makeTraceEntry('trend_ml_call', reason));
        trace.push(makeTraceEntry(
          'trend_demo_fallback',
          `Serving precomputed demo-region fallback computed ${fallback.computedAt.toISOString()} covering ${fallback.dateRange?.start?.toISOString().slice(0, 10)}..${fallback.dateRange?.end?.toISOString().slice(0, 10)}`
        ));
        const answerText = await composeTrendAnswer(fallback.result, fallback.confidence, trace);
        const evidence = { ...(fallback.evidence || {}), isDemoPrecompute: true, data_source: 'demo-precompute' };
        return res.status(200).json({
          answerText,
          taskType: TREND_TASK_TYPE,
          result: fallback.result || {},
          evidence,
          confidence: fallback.confidence || 0,
          executionTrace: trace,
          status: 'success',
          cache: { hit: true, source: 'demo-precompute', computedAt: fallback.computedAt },
          fallback: {
            source: 'demo-precompute',
            computedAt: fallback.computedAt.toISOString(),
            dateRange: {
              start: fallback.dateRange?.start?.toISOString().slice(0, 10),
              end: fallback.dateRange?.end?.toISOString().slice(0, 10)
            },
            note: `Live ML /trend returned a labeled mock/fallback result. Serving the precomputed demo-region result.`
          }
        });
      }
    }

    trace.push(makeTraceEntry('trend_ml_call', `ML /trend returned ${(result.series || []).length} data point(s)${isMockTrendResult(mlResult) ? ' (labeled mock/fallback — not cached as real data)' : ''}`));

    // Only cache successful (non-mock) results (BACKEND.md §10). Guard against
    // inserting a duplicate where an existing exact/superset entry already
    // covers the request.
    const existing = await findCoveringCacheEntry({ region, metric: metricLower, startDate, endDate, interval });
    if (!existing && !isMockTrendResult(mlResult)) {
      try {
        await ResultsCache.create({
          tool: 'trend',
          metric: metricLower,
          region,
          regionKey: regionKey(region),
          dateRange: { start: new Date(startDate), end: new Date(endDate) },
          series: (result.series || []).map(p => ({ date: p.date, value: p.value ?? null })),
          interval,
          parameters: { region, metric: metricLower, startDate, endDate, interval },
          confidence,
          evidence,
          result,
          expiresAt: new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000),
          computedAt: new Date()
        });
        trace.push(makeTraceEntry('trend_cache_store', `Stored result in results_cache for ${metricLower}`));
      } catch (err) {
        // A concurrent identical request can hit the unique dedup index and raise
        // E11000 after both missed the covering check. That is not a failure: the
        // computed result is still valid and identical — serve it, don't 500.
        if (err && err.code === 11000) {
          trace.push(makeTraceEntry('trend_cache_store', 'Deduplicated concurrent cache insert; reusing in-flight result'));
        } else {
          throw err;
        }
      }
    }

    const answerText = await composeTrendAnswer(result, confidence, trace);
    return res.status(200).json({
      answerText,
      taskType: TREND_TASK_TYPE,
      result,
      evidence,
      confidence,
      executionTrace: trace,
      status: 'success',
      cache: { hit: false }
    });
  } catch (error) {
    console.error('[Trend] Error processing trend query:', error);
    return res.status(500).json(trendFailureResponse('An internal error occurred while processing the trend query.'));
  }
});

/**
 * GET /api/query/history
 */
router.get('/history', async (req, res) => {
  try {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim().slice(0, 128) : '';
    const limitRaw = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 50;
    const filter = sessionId ? { sessionId } : {};
    const queries = await Query.find(filter).sort({ createdAt: -1 }).limit(limit);
    return res.status(200).json(queries);
  } catch (error) {
    console.error('[History] Error listing queries:', error);
    return res.status(500).json({ status: 'failed', error: 'An internal error occurred while listing queries.' });
  }
});

/**
 * GET /api/query/:id/report
 */
router.get('/:id/report', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ status: 'failed', error: 'Invalid query id format.' });
    }
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
      confidenceSignals: queryDoc.confidenceSignals || [],
      evidence: queryDoc.evidence,
      result: queryDoc.result,
      executionTrace: queryDoc.executionTrace,
      toolsInvoked: queryDoc.toolsInvoked || [],
      toolResults: queryDoc.toolResults || [],
      generatedAt: new Date().toISOString()
    };
    return res.status(200).json(report);
  } catch (error) {
    console.error('[Report] Error generating report:', error);
    return res.status(500).json({ status: 'failed', error: 'An internal error occurred while generating the report.' });
  }
});

/**
 * GET /api/query/:id
 */
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ status: 'failed', error: 'Invalid query id format.' });
    }
    const queryDoc = await Query.findById(req.params.id);
    if (!queryDoc) {
      return res.status(404).json({ status: 'failed', error: 'Query not found' });
    }
    return res.status(200).json(queryDoc);
  } catch (error) {
    console.error('[Query] Error fetching query:', error);
    return res.status(500).json({ status: 'failed', error: 'An internal error occurred while fetching the query.' });
  }
});

export default router;
