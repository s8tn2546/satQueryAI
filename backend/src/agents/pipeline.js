import mongoose from 'mongoose';
import Tile from '../models/Tile.js';
import Query from '../models/Query.js';
import { classifyIntent } from './intentClassifier.js';
import { validateInputs } from './inputValidator.js';
import { planTools } from './taskPlanner.js';
import { executeTools } from './toolExecutor.js';
import { estimateConfidence } from './confidenceEstimator.js';
import { composeAnswer } from './answerComposer.js';
import { makeTraceEntry, makeRejectedResponse, makeFailedResponse } from '../utils/responseBuilder.js';

const TASK_TYPE_ENUM = new Set(['VQA', 'CAPTION', 'GROUNDING', 'CHANGE_ANALYSIS', 'OPTICAL_SAR', 'NDVI', 'NDWI', 'AREA', 'TREND']);

function sanitizeImageRefs(refs) {
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs.filter(ref => mongoose.Types.ObjectId.isValid(ref));
}

function normalizeSessionId(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, 128) : null;
}

function clampConfidence(val) {
  if (typeof val !== 'number' || Number.isNaN(val)) return 0;
  return Math.min(1, Math.max(0, val));
}

function persistableToolResults(toolResults) {
  const validStatuses = new Set(['success', 'partial', 'failed', 'skipped']);
  return toolResults.map(tr => ({
    tool: tr.tool || 'unknown',
    status: validStatuses.has(tr.status) ? tr.status : 'failed',
    result: tr.result || {},
    evidence: tr.evidence || {},
    confidence: clampConfidence(tr.confidence),
    error: tr.error || '',
    metadata: tr.metadata || {}
  }));
}

function collectUniqueStrings(target, value) {
  if (value == null || value === '') return;
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (item == null) continue;
    const s = String(item);
    if (s && !target.includes(s)) target.push(s);
  }
}

/**
 * Aggregate evidence across every successful tool result (in execution order),
 * plus explicit notes for failed/skipped tools so the final evidence/trace stays
 * honest. Failed/skipped tools never contribute success evidence. The top-level
 * `result` remains the FIRST successful tool result for backward compatibility;
 * this helper only shapes the `evidence` object.
 */
function aggregateToolEvidence(imageRefs, successResults, allResults, parameters) {
  const images = [];
  collectUniqueStrings(images, imageRefs || []);

  const notes = [];
  for (const r of successResults) {
    const ev = r.evidence || {};
    collectUniqueStrings(images, ev.images);
    if (ev.image != null) collectUniqueStrings(images, String(ev.image));
    if (typeof ev.notes === 'string' && ev.notes) collectUniqueStrings(notes, ev.notes);
  }

  for (const r of allResults) {
    if (r.status === 'failed') {
      collectUniqueStrings(notes, `Tool "${r.tool}" failed: ${r.error || 'unknown error'}`);
    } else if (r.status === 'skipped') {
      collectUniqueStrings(notes, `Tool "${r.tool}" skipped: ${r.error || 'dependency not satisfied'}`);
    }
  }

  const region = successResults[0]?.evidence?.region || parameters?.region || {};

  return {
    images,
    region,
    notes: notes.length > 0 ? notes.join(' ') : ''
  };
}

export async function runAgentPipeline(queryText, imageRefIds, parameters = {}, options = {}) {
  const sessionId = normalizeSessionId(options?.sessionId);
  const trace = [];
  
  const sanitizedRefs = sanitizeImageRefs(imageRefIds);
  
  trace.push(makeTraceEntry('pipeline_start', `Received query with ${sanitizedRefs.length} image ref(s)`));

  let tiles = [];
  if (sanitizedRefs.length > 0) {
    try {
      tiles = await Tile.find({ _id: { $in: sanitizedRefs } });
    } catch (err) {
      console.error('[Pipeline] Failed to fetch tiles:', err.message);
      trace.push(makeTraceEntry('tile_fetch_error', `Could not fetch images: ${err.message}`));
    }
  }

  const classification = await classifyIntent(queryText, tiles, trace);
  const { taskType, toolNames, parameters: extractedParams } = classification;

  const mergedParams = { ...extractedParams, ...parameters };

  if (taskType === 'OUT_OF_SCOPE') {
    const reason = `This query is outside the supported scope of SatQuery AI. Supported tasks: ${[...TASK_TYPE_ENUM].join(', ')}.`;
    trace.push(makeTraceEntry('out_of_scope', reason));
    const response = makeRejectedResponse(reason, trace);

    let queryDoc;
    try {
      queryDoc = await Query.create({
        queryText,
        inputRefs: sanitizedRefs,
        sessionId,
        taskType: 'VQA',
        toolsInvoked: [],
        toolResults: [],
        parameters: mergedParams,
        result: {},
        evidence: response.evidence,
        confidence: 0,
        executionTrace: response.executionTrace,
        answerText: response.answerText,
        status: 'rejected'
      });
    } catch (err) {
      console.error('REJECTED QUERY CREATE ERROR 1:', err);
      throw err;
    }

    return { _id: queryDoc._id, toolResults: [], ...response };
  }

  const resolvedTaskType = TASK_TYPE_ENUM.has(taskType) ? taskType : 'VQA';

  const validationResult = validateInputs(resolvedTaskType, tiles, trace);
  if (!validationResult.valid) {
    const response = makeRejectedResponse(validationResult.reason, trace, resolvedTaskType);

    let queryDoc;
    try {
      queryDoc = await Query.create({
        queryText,
        inputRefs: sanitizedRefs,
        sessionId,
        taskType: resolvedTaskType,
        toolsInvoked: [],
        toolResults: [],
        parameters: mergedParams,
        result: {},
        evidence: response.evidence,
        confidence: 0,
        executionTrace: response.executionTrace,
        answerText: response.answerText,
        status: 'rejected'
      });
    } catch (err) {
      console.error('REJECTED QUERY CREATE ERROR 2:', err);
      throw err;
    }

    return { _id: queryDoc._id, toolResults: [], ...response };
  }

  const tools = await planTools(resolvedTaskType, toolNames, trace);
  const plan = tools.plan || null;

  trace.push(makeTraceEntry('parameter_extraction', `Parameters: ${JSON.stringify(mergedParams)}`));

  const toolResults = await executeTools(tools, tiles, mergedParams, trace, plan);

  if (toolResults.length === 0) {
    const reason = `No tools could be executed for task ${resolvedTaskType}.`;
    trace.push(makeTraceEntry('tool_execution_failed', reason));
    const response = makeFailedResponse(reason, resolvedTaskType, trace);

    let queryDoc;
    try {
      queryDoc = await Query.create({
        queryText,
        inputRefs: sanitizedRefs,
        sessionId,
        taskType: resolvedTaskType,
        toolsInvoked: tools.map(t => t.name),
        toolResults: [],
        parameters: mergedParams,
        plan,
        result: {},
        evidence: response.evidence,
        confidence: 0,
        executionTrace: response.executionTrace,
        answerText: response.answerText,
        status: 'failed'
      });
    } catch (err) {
      console.error('QUERY CREATE ERROR AT EMPTY TOOLS:', err.message, err.errors);
      throw err;
    }

    return { _id: queryDoc._id, toolResults: [], plan, ...response };
  }

  const successResults = toolResults.filter(r => r.status === 'success' || r.status === 'partial');
  const allFailed = successResults.length === 0 && toolResults.length > 0;

  if (allFailed) {
    const reasons = toolResults.map(r => r.error || 'unknown error').join('; ');
    const response = makeFailedResponse(reasons, resolvedTaskType, trace);
    const persistedToolResults = persistableToolResults(toolResults);

    let queryDoc;
    try {
      queryDoc = await Query.create({
        queryText,
        inputRefs: sanitizedRefs,
        sessionId,
        taskType: resolvedTaskType,
        toolsInvoked: tools.map(t => t.name),
        toolResults: persistedToolResults,
        parameters: mergedParams,
        plan,
        result: {},
        evidence: response.evidence,
        confidence: 0,
        executionTrace: response.executionTrace,
        answerText: response.answerText,
        status: 'failed'
      });
    } catch (err) {
      console.error('QUERY CREATE ERROR AT ALL FAILED:', err.message, err.errors);
      throw err;
    }

    return { _id: queryDoc._id, toolResults: persistedToolResults, plan, ...response };
  }

  const { score: confidence, signals: confidenceSignals } = estimateConfidence(validationResult, toolResults);
  trace.push(makeTraceEntry('confidence_estimation', `Confidence score: ${confidence}`));

  const primaryResult = successResults[0];
  const evidence = aggregateToolEvidence(sanitizedRefs, successResults, toolResults, mergedParams);

  const answerText = await composeAnswer(queryText, resolvedTaskType, toolResults, trace);

  trace.push(makeTraceEntry('execution_trace_assembly', 'Pipeline complete'));

  const overallStatus = toolResults.some(r => r.status === 'failed' || r.status === 'skipped' || r.status === 'partial') ? 'partial' : 'success';
  const persistedToolResults = persistableToolResults(toolResults);

  let queryDoc;
  try {
    queryDoc = await Query.create({
      queryText,
      inputRefs: sanitizedRefs,
      sessionId,
      taskType: resolvedTaskType,
      toolsInvoked: tools.map(t => t.name),
      toolResults: persistedToolResults,
      parameters: mergedParams,
      plan,
      result: primaryResult?.result || {},
      evidence,
      confidence: clampConfidence(confidence),
      confidenceSignals,
      executionTrace: trace,
      answerText,
      status: overallStatus
    });
  } catch (err) {
    console.error('QUERY CREATE ERROR:', err);
    throw err;
  }

  const interpretedPlan = {
    query: queryText,
    intent: resolvedTaskType.toLowerCase(),
    taskType: resolvedTaskType,
    metric: mergedParams.metric || (resolvedTaskType === 'NDVI' ? 'NDVI' : resolvedTaskType === 'NDWI' ? 'NDWI' : null),
    aoi: mergedParams.roi || mergedParams.region || 'selected_context',
    dateRange: {
      start: mergedParams.startDate || mergedParams.start_date || null,
      end: mergedParams.endDate || mergedParams.end_date || null
    },
    operations: ['validate', 'fetch', ...tools.map(t => `calculate_${t.name}`), 'map']
  };

  return {
    _id: queryDoc._id,
    answerText,
    taskType: resolvedTaskType,
    result: primaryResult?.result || {},
    plan,
    interpretedPlan,
    toolResults: persistedToolResults,
    evidence,
    confidence,
    confidenceSignals,
    qualityReport: validationResult.qualityReport,
    executionTrace: trace,
    status: overallStatus
  };
}
