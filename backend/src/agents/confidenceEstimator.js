export function estimateConfidence(validationResult, toolResults) {
  let score = 0.5;
  const signals = [];

  if (validationResult.valid && (!validationResult.warnings || validationResult.warnings.length === 0)) {
    score += 0.15;
    signals.push('+0.15: input validation passed without warnings');
  } else if (validationResult.valid) {
    score += 0.05;
    signals.push('+0.05: input validation passed with warnings');
  }

  const successResults = toolResults.filter(r => r.status === 'success');
  const failedResults = toolResults.filter(r => r.status === 'failed');

  for (const r of successResults) {
    const toolConf = r.confidence ?? r.result?.confidence;
    if (typeof toolConf === 'number') {
      if (toolConf >= 0.85) {
        score += 0.2;
        signals.push(`+0.2: tool "${r.tool}" reported high confidence (${toolConf.toFixed(2)})`);
      } else if (toolConf >= 0.6) {
        score += 0.1;
        signals.push(`+0.1: tool "${r.tool}" reported moderate confidence (${toolConf.toFixed(2)})`);
      } else {
        signals.push(`±0: tool "${r.tool}" reported low confidence (${toolConf.toFixed(2)})`);
      }
    }
  }

  if (successResults.some(r => r.metadata?.coRegistered === true)) {
    score += 0.1;
    signals.push('+0.1: cross-modal pair fully co-registered');
  }

  if (successResults.some(r => r.metadata?.cloudGaps || r.result?.missingDates)) {
    score -= 0.1;
    signals.push('-0.1: missing or partial data (cloud gaps / missing dates)');
  }

  if (failedResults.length > 0) {
    score -= 0.2 * failedResults.length;
    signals.push(`-${0.2 * failedResults.length}: ${failedResults.length} tool(s) failed`);
  }

  const clamped = Math.min(1, Math.max(0, score));
  return { score: parseFloat(clamped.toFixed(3)), signals };
}
