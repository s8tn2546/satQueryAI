import mongoose from 'mongoose';
import Tile from '../models/Tile.js';
import Query from '../models/Query.js';
import { classifyIntent } from './intentClassifier.js';
import { validateInputs } from './inputValidator.js';
import { planTools } from './taskPlanner.js';
import { executeTools } from './toolExecutor.js';
import { estimateConfidence } from './confidenceEstimator.js';
import { composeAnswer } from './answerComposer.js';
import { makeTraceEntry, makeRejectedResponse, makeFailedResponse, buildEvidence } from '../utils/responseBuilder.js';

const TASK_TYPE_ENUM = new Set(['VQA', 'CAPTION', 'GROUNDING', 'CHANGE_ANALYSIS', 'OPTICAL_SAR', 'NDVI', 'NDWI', 'AREA', 'TREND']);

function sanitizeImageRefs(refs) {
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs.filter(ref => mongoose.Types.ObjectId.isValid(ref));
}

function persistableToolResults(toolResults) {
  return toolResults.map(tr => ({
    tool: tr.tool,
    status: tr.status,
    result: tr.result || {},
    evidence: tr.evidence || {},
    confidence: typeof tr.confidence === 'number' ? tr.confidence : 0,
    error: tr.error || ''
  }));
}

export async function runAgentPipeline(queryText, imageRefIds, parameters = {}) {
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

    const queryDoc = await Query.create({
      queryText,
      inputRefs: sanitizedRefs,
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

    return { _id: queryDoc._id, toolResults: [], ...response };
  }

  const resolvedTaskType = TASK_TYPE_ENUM.has(taskType) ? taskType : 'VQA';

  const validationResult = validateInputs(resolvedTaskType, tiles, trace);
  if (!validationResult.valid) {
    const response = makeRejectedResponse(validationResult.reason, trace, resolvedTaskType);

    const queryDoc = await Query.create({
      queryText,
      inputRefs: sanitizedRefs,
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

    return { _id: queryDoc._id, toolResults: [], ...response };
  }

  const tools = await planTools(resolvedTaskType, toolNames, trace);
  const plan = tools.plan || null;

  trace.push(makeTraceEntry('parameter_extraction', `Parameters: ${JSON.stringify(mergedParams)}`));

  const toolResults = await executeTools(tools, tiles, mergedParams, trace);

  if (toolResults.length === 0) {
    const reason = `No tools could be executed for task ${resolvedTaskType}.`;
    trace.push(makeTraceEntry('tool_execution_failed', reason));
    const response = makeFailedResponse(reason, resolvedTaskType, trace);

    const queryDoc = await Query.create({
      queryText,
      inputRefs: sanitizedRefs,
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

    return { _id: queryDoc._id, toolResults: [], plan, ...response };
  }

  const successResults = toolResults.filter(r => r.status === 'success');
  const allFailed = successResults.length === 0 && toolResults.length > 0;

  if (allFailed) {
    const reasons = toolResults.map(r => r.error || 'unknown error').join('; ');
    const response = makeFailedResponse(reasons, resolvedTaskType, trace);
    const persistedToolResults = persistableToolResults(toolResults);

    const queryDoc = await Query.create({
      queryText,
      inputRefs: sanitizedRefs,
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

    return { _id: queryDoc._id, toolResults: persistedToolResults, plan, ...response };
  }

  const { score: confidence } = estimateConfidence(validationResult, toolResults);
  trace.push(makeTraceEntry('confidence_estimation', `Confidence score: ${confidence}`));

  const primaryResult = successResults[0];
  const evidence = buildEvidence(sanitizedRefs, primaryResult, mergedParams);

  const answerText = await composeAnswer(queryText, resolvedTaskType, toolResults, trace);

  trace.push(makeTraceEntry('execution_trace_assembly', 'Pipeline complete'));

  const overallStatus = toolResults.some(r => r.status === 'failed') ? 'partial' : 'success';
  const persistedToolResults = persistableToolResults(toolResults);

  const queryDoc = await Query.create({
    queryText,
    inputRefs: sanitizedRefs,
    taskType: resolvedTaskType,
    toolsInvoked: tools.map(t => t.name),
    toolResults: persistedToolResults,
    parameters: mergedParams,
    plan,
    result: primaryResult.result || {},
    evidence,
    confidence,
    executionTrace: trace,
    answerText,
    status: overallStatus
  });

  return {
    _id: queryDoc._id,
    answerText,
    taskType: resolvedTaskType,
    result: primaryResult.result || {},
    plan,
    toolResults: persistedToolResults,
    evidence,
    confidence,
    executionTrace: trace,
    status: overallStatus
  };
}
