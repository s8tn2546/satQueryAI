/**
 * Results-presentation helpers for SatQuery AI.
 *
 * These functions are pure and only ever FAITHFULLY relay values that already
 * exist in the backend response/tool results. They never invent numbers,
 * sizes, locations, extents, trends or explanations.
 */

const BINARY_VQA_RE = /^\s*(yes|no)\b/i;

export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function toPercent(v) {
  if (!isFiniteNumber(v)) return null;
  return `${Math.round(v * 1000) / 10}%`;
}

/** Format a measured value with at most `digits` decimals (no float noise). */
export function formatValue(v, digits = 2) {
  if (!isFiniteNumber(v)) return null;
  const factor = 10 ** digits;
  return String(Math.round(v * factor) / factor);
}

/**
 * Format an already-percentage-scaled value (0..100) at 1 decimal place.
 * Unlike toPercent (which converts a 0..1 fraction), this value is already a
 * percentage, e.g. change_percentage = 11.582242 → "11.6%".
 */
export function formatPercent(v, digits = 1) {
  const val = formatValue(v, digits);
  return val === null ? null : `${val}%`;
}

/** Human-readable label for a change-detection method (fallback: raw method). */
const CHANGE_METHOD_LABELS = {
  absolute_difference: 'Pixel-level absolute difference',
};

export function changeMethodLabel(method) {
  if (typeof method !== 'string') return null;
  return CHANGE_METHOD_LABELS[method] || method;
}

/** Readable label for the change threshold source. */
export function thresholdSourceLabel(source) {
  if (source === 'auto_2sigma') return 'auto (2σ)';
  if (source === 'explicit') return 'explicit';
  if (typeof source === 'string') return source;
  return null;
}

/**
 * Deterministic headline verdict for bi-temporal change detection.
 *
 * A PRESENTATION heuristic derived ONLY from the measured `change_percentage`
 * (the fraction of compared pixels that exceeded the threshold). It never
 * alters the tool's numbers and never adds semantic claims (buildings, water,
 * etc.) — it only describes the magnitude of the pixel-level change.
 */
const MAJOR_CHANGE_PCT = 5; // ≥5% of compared pixels → "Major"
export function changeVerdict(pct) {
  if (isFiniteNumber(pct) && pct > 0) {
    if (pct >= MAJOR_CHANGE_PCT) {
      return { label: 'Major change detected between T1 and T2.', status: 'major' };
    }
    return { label: 'Change detected between T1 and T2.', status: 'minor' };
  }
  return { label: 'No significant pixel-level change detected between T1 and T2.', status: 'none' };
}

/** First tool result entry for the given tool name (any status). */
export function toolResult(toolResults, tool) {
  if (!Array.isArray(toolResults)) return null;
  return toolResults.find((t) => t && t.tool === tool) || null;
}

/** First successful tool result entry. */
export function successfulToolResult(toolResults, tool) {
  if (!Array.isArray(toolResults)) return null;
  return toolResults.find((t) => t && t.tool === tool && t.status === 'success') || null;
}

/** Raw vision-model answer for VQA-style tasks (result.answer or answerText). */
export function rawVqaAnswer(toolResults, answerText) {
  const vqa = toolResult(toolResults, 'vqa');
  if (vqa && typeof vqa.result === 'object' && vqa.result && typeof vqa.result.answer === 'string' && vqa.result.answer.trim()) {
    return vqa.result.answer;
  }
  return typeof answerText === 'string' && answerText.trim() ? answerText : '';
}

/** True when a query is a simple yes/no visual question and the model replied unambiguously. */
export function isBinaryVqa(taskType, rawAnswer, query) {
  if (taskType !== 'VQA') return false;
  if (!BINARY_VQA_RE.test(rawAnswer)) return false;
  if (!query) return true;
  // Guard: questions already looking for a measurement ("how many", "how much")
  // are not reported as plain yes/no verdicts.
  return !/\b(how many|how much|what level|what area)\b/i.test(query);
}

/** Extract the noun phrase the question asks about, if it parses cleanly. */
export function vqaTarget(question) {
  if (!question) return null;
  const q = question.trim();
  const patterns = [
    /\b(?:is|are)\s+(?:there\s+)?(?:any\s+|the\s+)?(.+?)\s+(?:visible|present|detected|located)\b/i,
    /\b(?:is|are)\s+there\s+(.+?)\s+(?:in|on|within|anywhere\s+in|near)\b/i,
    /\b(?:does|do)\s+(?:the\s+|this\s+)?(.+?)\s+(?:appear|show|contain)\b/i,
    /\byes\s*[,:]?\s*is\s+there\s+(.+?)[?.]?\s*$/i
  ];
  for (const re of patterns) {
    const m = q.match(re);
    if (m && m[1] && typeof m[1] === 'string') {
      const target = m[1].replace(/\bthe\b/gi, '').replace(/^(?:a|an)\s+/i, '').replace(/\s+/g, ' ').trim();
      if (target) return target;
    }
  }
  return null;
}

/**
 * Build the FINDINGS block:
 * { primary, explanation, isBinary, modelName, adapterActive }
 *
 * `primary` is the large headline, `explanation` a single grounded line.
 */
export function buildFindings({ taskType, answerText, toolResults, query, status }) {
  const raw = rawVqaAnswer(toolResults, answerText);
  const firstWithMeta = (Array.isArray(toolResults) ? toolResults : [])
    .find((t) => t && t.metadata && (t.metadata.model || t.metadata.adapter_used !== undefined));
  const modelName = (firstWithMeta && firstWithMeta.metadata && firstWithMeta.metadata.model) || null;
  const adapterActive = (firstWithMeta && firstWithMeta.metadata && typeof firstWithMeta.metadata.adapter_used === 'boolean')
    ? firstWithMeta.metadata.adapter_used
    : null;

  const failed = status === 'failed' || status === 'rejected';

  if (failed) {
    const needsGeoref = /georeferenc/i.test(String(answerText || ''));
    if (taskType === 'OPTICAL_SAR' && needsGeoref) {
      return {
        primary: 'Optical + SAR analysis could not be completed.',
        explanation: 'Optical + SAR analysis requires georeferenced optical and SAR rasters.',
        isBinary: false,
        modelName,
        adapterActive
      };
    }
    return {
      primary: status === 'rejected' ? 'Query rejected.' : 'Analysis could not be completed.',
      explanation: String(answerText || '').replace(/^Unable to process(?: your request)?:?\s*/i, ''),
      isBinary: false,
      modelName,
      adapterActive
    };
  }

  switch (taskType) {
    case 'VQA': {
      if (isBinaryVqa(taskType, raw, query)) {
        const verdict = /^\s*yes\b/i.test(raw) ? 'Yes' : 'No';
        const target = vqaTarget(query);
        const primary = target
          ? (verdict === 'Yes'
            ? `${verdict} — ${target} is detected in the scene.`
            : `${verdict} — no clear ${target} was detected in the provided image.`)
          : verdict;
        return {
          primary,
          explanation: `The vision-language model answered "${raw.trim()}" to this question.`,
          isBinary: true,
          modelName,
          adapterActive
        };
      }
      return {
        primary: answerText || 'No finding available.',
        explanation: 'Answer generated by the vision-language model from the source imagery.',
        isBinary: false,
        modelName,
        adapterActive
      };
    }

    case 'CAPTION':
      return {
        primary: answerText || 'No caption generated.',
        explanation: 'Description generated directly by the captioning vision-language model from the source imagery.',
        isBinary: false,
        modelName,
        adapterActive
      };

    case 'CHANGE_ANALYSIS': {
      const change = successfulToolResult(toolResults, 'change');
      const result = change && change.result ? change.result : {};
      const pct = isFiniteNumber(result.change_percentage)
        ? result.change_percentage
        : isFiniteNumber(result.changePercentage)
          ? result.changePercentage
          : null;
      if (pct !== null) {
        const verdict = changeVerdict(pct);
        const percentLabel = formatPercent(pct);
        const method = changeMethodLabel(result.method);
        const explanation = method
          ? `${percentLabel} of the compared pixels exceeded the configured change threshold (${method}).`
          : `${percentLabel} of the compared pixels exceeded the configured change threshold.`;
        return {
          primary: verdict.label,
          explanation,
          isBinary: false,
          modelName,
          adapterActive
        };
      }
      return {
        primary: answerText || 'No change result returned.',
        explanation: 'Result reported by the change-detection tool.',
        isBinary: false,
        modelName,
        adapterActive
      };
    }

    case 'OPTICAL_SAR': {
      const fused = successfulToolResult(toolResults, 'optical_sar');
      if (fused && fused.result && fused.result.fusedLandCover) {
        return {
          primary: 'Cross-modal fusion completed.',
          explanation: `Fused land-cover result: ${JSON.stringify(fused.result.fusedLandCover)}`,
          isBinary: false,
          modelName,
          adapterActive
        };
      }
      return {
        primary: answerText || 'Fusion analysis produced no output.',
        explanation: 'Result reported by the optical + SAR fusion tool.',
        isBinary: false,
        modelName,
        adapterActive
      };
    }

    default:
      return {
        primary: answerText || 'No finding available.',
        explanation: 'Direct output of the analysis tool.',
        isBinary: false,
        modelName,
        adapterActive
      };
  }
}

/**
 * TREND state built ONLY from actual returned values.
 * Returns null when the query was not a trend query or no series data exists.
 */
export function buildTrendState({ taskType, toolResults, trendData, parameters }) {
  if (taskType !== 'TREND') {
    return {
      requested: false
    };
  }

  const trend = successfulToolResult(toolResults, 'trend');
  const raw = (trend && trend.result && Array.isArray(trend.result.series))
    ? trend.result
    : (trendData && typeof trendData === 'object' && Array.isArray(trendData.series) ? trendData : null);

  if (!raw || !Array.isArray(raw.series) || raw.series.length === 0) {
    return {
      requested: true,
      data: false
    };
  }

  const points = raw.series
    .filter((p) => p && isFiniteNumber(p.value))
    .map((p) => ({
      label: String(p.date || p.label || p.month || '').slice(0, 10),
      value: p.value,
      metric: raw.metric || (trendData && trendData.metric)
    }));

  const metric = raw.metric || parameters?.metric || null;
  const region = (parameters && parameters.region)
    ? (typeof parameters.region === 'string' ? parameters.region : (parameters.region.name || 'Provided region'))
    : (raw.region ? (typeof raw.region === 'string' ? raw.region : (raw.region.name || 'Provided region')) : null);

  const period = points.length >= 2
    ? `${points[0].label} → ${points[points.length - 1].label}`
    : (points[0] ? points[0].label : null);

  let direction = null;
  if (points.length >= 2) {
    const delta = points[points.length - 1].value - points[0].value;
    direction = delta > 0 ? 'Increasing' : delta < 0 ? 'Decreasing' : 'Stable';
  }

  return {
    requested: true,
    data: true,
    metric,
    region,
    period,
    direction,
    summary: typeof raw.summary === 'string' ? raw.summary : null,
    points
  };
}

const STEP_LABELS = {
  pipeline_start: 'Pipeline started',
  intent_classification_start: 'Intent identified',
  intent_classification: 'Intent identified',
  input_validation: 'Input validated',
  parameter_extraction: 'Parameters extracted',
  task_planning: 'Plan generated',
  tool_selection: 'Tool selected',
  tool_execution_start: 'Tool selected',
  tool_execution_success: 'Tool executed',
  tool_execution_failed: 'Tool execution failed',
  tool_execution_skipped: 'Tool skipped',
  tool_execution_derived: 'Tool output derived',
  confidence_estimation: 'Confidence calculated',
  answer_generation_start: 'Answer composed',
  answer_generation: 'Answer composed',
  execution_trace_assembly: 'Trace assembled',
  out_of_scope: 'Out of scope',
  tile_fetch_error: 'Source imagery lookup',
  rejected: 'Query rejected',
  failed: 'Failed',
  error: 'Internal error',
  trend_cache_check: 'Trend cache check',
  trend_cache_hit: 'Trend cache hit',
  trend_cache_store: 'Trend result cached',
  trend_ml_call: 'Trend model call',
  trend_ml_failed: 'Trend model call failed',
  trend_validation_failed: 'Trend input validated'
};

const FAILURE_STEP = new Set([
  'tool_execution_failed',
  'tool_execution_skipped',
  'tile_fetch_error',
  'rejected',
  'failed',
  'error',
  'trend_ml_failed'
]);

export function traceStepView(step, index) {
  const key = typeof step.step === 'string' ? step.step : 'step';
  return {
    number: String(index + 1).padStart(2, '0'),
    title: STEP_LABELS[key] || (typeof step.title === 'string' ? step.title : key),
    detail: typeof step.detail === 'string' ? step.detail : '',
    failed: FAILURE_STEP.has(key),
    step: key
  };
}

/**
 * Normalize a backend execution trace into a display list.
 *
 * The pipeline emits redundant mirror steps (e.g. `intent_classification_start`
 * plus `intent_classification`, `tool_execution_start` plus
 * `tool_execution_success`) and a bookmarking `pipeline_start`. For readability
 * we collapse those so the user sees at most one row per real phase:
 *  - `pipeline_start` is dropped (it is not an actual stage).
 *  - a trailing `*_start` mirror is dropped when its plain counterpart exists.
 *  - `tool_execution_start` is dropped when a terminal tool-execution step
 *    exists (success/failed/skipped/derived); otherwise it is shown as the
 *    canonical "Tool executed" row so in-flight traces still render.
 * Steps are then renumbered sequentially; order is preserved.
 */
export function traceLabel(steps) {
  if (!Array.isArray(steps)) return [];

  const raw = steps.filter((s) => s && typeof s.step === 'string' && s.step !== 'pipeline_start');

  const stepKeys = new Set(raw.map((s) => s.step));
  const terminalTool = raw.some((s) =>
    ['tool_execution_success', 'tool_execution_failed', 'tool_execution_skipped', 'tool_execution_derived'].includes(s.step)
  );

  const visible = raw.filter((s) => {
    if (s.step === 'tool_execution_start') return !terminalTool;
    if (s.step.endsWith('_start')) {
      const plain = s.step.slice(0, -'_start'.length);
      return !stepKeys.has(plain);
    }
    return true;
  });

  return visible.map((s, i) => traceStepView(s, i));
}

/** Confidence for a specific tool result, formatted. */
export function toolConfidence(toolResults, tool) {
  const entry = toolResult(toolResults, tool);
  if (entry && isFiniteNumber(entry.confidence)) {
    return `${Math.round(entry.confidence * 1000) / 10}%`;
  }
  return null;
}

/** Tool/model confidence for the primary tool of a task type. */
export function primaryToolName(taskType) {
  const map = {
    VQA: 'vqa',
    CAPTION: 'caption',
    CHANGE_ANALYSIS: 'change',
    OPTICAL_SAR: 'optical_sar',
    GROUNDING: 'ground',
    NDVI: 'ndvi',
    NDWI: 'ndwi',
    AREA: 'area',
    TREND: 'trend'
  };
  return map[taskType] || null;
}