import mongoose from 'mongoose';
import { runAgentPipeline } from '../agents/pipeline.js';

/**
 * Shared query-request handling for BOTH the synchronous POST /api/query route
 * and the async job worker. The pipeline is executed here in exactly one place,
 * so the two paths can never drift apart.
 *
 * Validation mirrors the historical inline contract (identical HTTP status and
 * rejection payloads). `parseQueryRequest` returns normalized values so the
 * async worker persists the same sanitized inputs the sync path executes.
 */

function rejectedResponse(answerText, note, detail) {
  return {
    answerText,
    taskType: 'VQA',
    result: {},
    evidence: { images: [], region: {}, notes: note },
    confidence: 0,
    executionTrace: [{ step: 'input_validation', detail, timestamp: new Date().toISOString() }],
    status: 'rejected'
  };
}

export function parseQueryRequest(body = {}) {
  const { queryText, imageRefs = [], parameters = {}, sessionId } = body;

  if (typeof queryText !== 'string' || queryText.trim() === '') {
    return {
      ok: false,
      httpStatus: 400,
      response: rejectedResponse(
        'Query text is required.',
        'Validation failure: empty queryText',
        'Query text was missing or empty'
      )
    };
  }

  if (sessionId !== undefined && typeof sessionId !== 'string') {
    return {
      ok: false,
      httpStatus: 400,
      response: rejectedResponse(
        'sessionId must be a string.',
        'Validation failure: sessionId is not a string',
        'sessionId was not a string'
      )
    };
  }

  if (!Array.isArray(imageRefs)) {
    return {
      ok: false,
      httpStatus: 400,
      response: rejectedResponse(
        'imageRefs must be an array of tile IDs.',
        'Validation failure: imageRefs is not an array',
        'imageRefs was not an array'
      )
    };
  }

  const invalidRefs = imageRefs.filter(ref => !mongoose.isValidObjectId(ref));
  if (invalidRefs.length > 0) {
    return {
      ok: false,
      httpStatus: 400,
      response: rejectedResponse(
        `Invalid image reference(s): ${invalidRefs.join(', ')}`,
        'Validation failure: malformed image reference',
        'One or more imageRefs were malformed'
      )
    };
  }

  return {
    ok: true,
    values: {
      queryText: queryText.trim(),
      imageRefs,
      parameters: parameters || {},
      sessionId
    }
  };
}

/**
 * Runs one query request through the shared pipeline. `stageSink` is optional;
 * the async worker supplies it to persist real pipeline stages. Returns
 * `{ ok: false, httpStatus, response }` for input rejections or
 * `{ ok: true, response }` for executed results.
 */
export async function executeQueryRequest(body = {}, { stageSink } = {}) {
  const parsed = parseQueryRequest(body);
  if (!parsed.ok) {
    return parsed;
  }

  const { queryText, imageRefs, parameters, sessionId } = parsed.values;
  const response = await runAgentPipeline(queryText, imageRefs, parameters, {
    sessionId,
    ...(typeof stageSink === 'function' ? { stageSink } : {})
  });

  return { ok: true, response };
}