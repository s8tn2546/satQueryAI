export function makeTraceEntry(step, detail) {
  return { step, detail, timestamp: new Date().toISOString() };
}

export function makeRejectedResponse(reason, trace = [], taskType = 'VQA') {
  return {
    answerText: reason,
    taskType,
    result: {},
    evidence: { images: [], region: {}, notes: reason },
    confidence: 0,
    executionTrace: [...trace, makeTraceEntry('rejected', reason)],
    status: 'rejected'
  };
}

export function makeFailedResponse(reason, taskType = 'VQA', trace = []) {
  return {
    answerText: `Unable to process your request: ${reason}`,
    taskType,
    result: {},
    evidence: { images: [], region: {}, notes: reason },
    confidence: 0,
    executionTrace: [...trace, makeTraceEntry('failed', reason)],
    status: 'failed'
  };
}

export function buildEvidence(imageRefs, mlResult, parameters) {
  return {
    images: imageRefs.map(String),
    region: mlResult?.evidence?.region || parameters?.region || {},
    notes: mlResult?.evidence ? JSON.stringify(mlResult.evidence) : ''
  };
}
