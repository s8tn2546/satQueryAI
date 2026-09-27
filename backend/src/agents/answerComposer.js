import Anthropic from '@anthropic-ai/sdk';
import { makeTraceEntry } from '../utils/responseBuilder.js';
import { LLM_MODE, describeLlmMode, resolveLlmConfig } from '../utils/llmConfig.js';

// ---------------------------------------------------------------------------
// Task-conditioned answer structure
// ---------------------------------------------------------------------------
//
// Each task family gets an explicit outline. The outline is what turns a bare
// measurement into an answer a domain expert can act on, and it keeps the LLM
// from improvising sections that have no evidence behind them.

const SINGLE_SCENE_OUTLINE = [
  'Observation — what is directly visible in the scene.',
  'Quantitative evidence — the measured values actually present in the tool result.',
  'Interpretation — what those values support, phrased as an inference.',
  'Confidence and limitations — the reported confidence plus what the image cannot settle.'
];

const INDEX_OUTLINE = [
  'Value and what it measures — the index value and the physical quantity it represents.',
  'Valid-pixel coverage — how many pixels were actually measured, and out of how many.',
  'Interpretation — what that measured value supports, grounded in the number.',
  'Confidence and limitations — reported confidence and the constraints of the measurement.'
];

const CHANGE_OUTLINE = [
  'What changed — the nature of the detected change.',
  'Change magnitude — the measured magnitude of the difference.',
  'Area or percentage — the changed extent, as reported.',
  'Spatial or temporal context — only if the tool actually reported it.',
  'Confidence and limitations — reported confidence and what cannot be concluded.'
];

const TREND_OUTLINE = [
  'Trend direction — increasing, decreasing, or stable.',
  'Magnitude or slope — only the value present in the result.',
  'Number of valid observations — how many data points back the trend.',
  'Gaps or excluded observations — only if reported.',
  'Confidence and limitations — reported confidence and coverage caveats.'
];

const FUSION_OUTLINE = [
  'Optical evidence — what the optical measurement shows.',
  'SAR evidence — what the SAR measurement shows.',
  'What the combined evidence supports — the joint reading of both.',
  'What cannot be determined — explicitly state what is not resolvable from these two modalities.',
  'Confidence and limitations — reported confidence and the assumptions involved.'
];

const AREA_OUTLINE = [
  'Measured area and units — the area value exactly as reported.',
  'How it was measured — basis available from the result, such as pixel count or feature type.',
  'Spatial extent context — only what the result actually states.',
  'Confidence and limitations — reported confidence and what was not accounted for.'
];

const MULTI_EVIDENCE_OUTLINE = [
  'What was asked — the question, answered directly in the first line.',
  'Evidence by measurement — one clearly labelled statement per successful tool, using only the values reported.',
  'What the combined evidence supports — the joint reading, phrased as inference.',
  'Conflicts or gaps — where two tools disagree or a requested measurement is missing.',
  'Confidence and limitations — reported confidence and what the data cannot settle.'
];

const TASK_OUTLINES = {
  VQA: SINGLE_SCENE_OUTLINE,
  CAPTION: SINGLE_SCENE_OUTLINE,
  GROUNDING: SINGLE_SCENE_OUTLINE,
  NDVI: INDEX_OUTLINE,
  NDWI: INDEX_OUTLINE,
  CHANGE_ANALYSIS: CHANGE_OUTLINE,
  TREND: TREND_OUTLINE,
  OPTICAL_SAR: FUSION_OUTLINE,
  AREA: AREA_OUTLINE
};

/**
 * One-line task instruction, always emitted.
 *
 * The full numbered outline is suppressed for a simple result to stop the model
 * padding, but the task framing must survive: "how much did it change?" still
 * needs a magnitude-first answer, and a plain measurement still needs to be
 * named as a measurement.
 */
const TASK_LEADS = {
  VQA: 'Answer the question about what is visible in the scene. Report only what the image supports.',
  CAPTION: 'Describe the scene. Separate what is visible from what you infer.',
  GROUNDING: 'Locate the referenced feature and describe where it sits in the scene.',
  NDVI: 'State the measured index value, what it represents physically, and what that value does and does not imply about vegetation.',
  NDWI: 'State the measured index value, what it represents physically, and what that value does and does not imply about water content.',
  CHANGE_ANALYSIS: 'State what changed and by how much, using the reported magnitude. Give the magnitude before any interpretation.',
  TREND: 'State the direction of change over time first, then the magnitude or slope, then how many valid observations support it.',
  OPTICAL_SAR: 'Report the optical and SAR evidence separately, then what the combination supports.',
  AREA: 'State the measured area with its exact units, then the basis of the measurement.'
};

/**
 * Pick the outline for this answer.
 *
 * A single-task outline is wrong as soon as two different tools succeeded: a
 * "what is directly visible in the scene" lead does not fit a change-magnitude
 * question, and forcing it makes the model pad. Multi-tool runs therefore get
 * an evidence-per-measurement outline instead.
 */
function outlineFor(taskType, toolResults = []) {
  const distinct = new Set(
    (Array.isArray(toolResults) ? toolResults : [])
      .filter(r => r && r.status === 'success' && r.tool)
      .map(r => String(r.tool).toLowerCase())
  );
  if (distinct.size > 1) return MULTI_EVIDENCE_OUTLINE;
  return TASK_OUTLINES[taskType] || SINGLE_SCENE_OUTLINE;
}

// ---------------------------------------------------------------------------
// Compact, structured context
// ---------------------------------------------------------------------------

const MAX_ARRAY_SAMPLE = 5;
const MAX_EVIDENCE_ITEMS = 6;
const MAX_STRING = 160;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clip(value, max = MAX_STRING) {
  if (typeof value !== 'string') return value;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Replace null / undefined / non-finite values with an explicit label so a
 * missing measurement stays visible.
 *
 * `JSON.stringify(NaN)` yields `null`, so a non-finite measurement would
 * otherwise appear as a null field and read like a real reported value.
 */
function stripUnrenderable(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return 'not a finite number';
  if (Array.isArray(value)) return value.map(stripUnrenderable);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) out[k] = 'not reported';
      else out[k] = stripUnrenderable(v);
    }
    return out;
  }
  return value;
}

/**
 * Compact a raw result so the prompt keeps structure without unbounded size:
 * arrays are sampled, long strings clipped, and metadata-only keys dropped.
 */
function compactResult(result) {
  if (!isPlainObject(result) && !Array.isArray(result)) return result ?? null;

  if (Array.isArray(result)) {
    const sample = result.slice(0, MAX_ARRAY_SAMPLE);
    return {
      sampled: true,
      shown: sample.length,
      total: result.length,
      items: sample.map(compactResult)
    };
  }

  const out = {};
  for (const [key, value] of Object.entries(result)) {
    // AOI reports are summarized explicitly below; no need to inline them raw.
    if (key === 'aoi') continue;
    if (value === undefined) continue;

    if (typeof value === 'string') out[key] = clip(value);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (Array.isArray(value)) out[key] = compactResult(value);
    else if (isPlainObject(value)) {
      // Nested evidence/metadata objects are rarely useful verbatim; keep them
      // shallow so the measured scalars still dominate the context.
      const shallow = {};
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined) continue;
        if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') shallow[k] = clip(v);
        else if (v === null) shallow[k] = null;
      }
      out[key] = Object.keys(shallow).length ? shallow : '[omitted: non-scalar detail]';
    } else out[key] = String(value);
  }
  return out;
}

/**
 * Summarize the AOI scope actually applied, so the answer can state the real
 * spatial scope instead of implying the whole scene.
 */
function summarizeAoi(toolResult) {
  const aoi = toolResult?.result?.aoi || toolResult?.metadata?.aoi;
  if (!aoi || !isPlainObject(aoi)) return null;
  if (aoi.aoiPresent === false) return { requested: false };

  const summary = {
    requested: true,
    applied: aoi.aoiApplied === true,
    scope: aoi.aoiScope || null,
    status: aoi.aoiStatus || null
  };
  if (aoi.aoiMaskedPixels != null) summary.maskedPixelsOutsideAoi = aoi.aoiMaskedPixels;
  // Keep the pixel accounting: without it the model cannot tell a full-scene
  // measurement from one that only covered a sliver of the AOI. Key names
  // follow the ML AoiScope.metadata() report.
  if (aoi.validPixels != null) summary.validPixels = aoi.validPixels;
  if (aoi.maskedOutPixels != null) summary.maskedOutPixels = aoi.maskedOutPixels;
  if (aoi.aoiCrs) summary.crs = aoi.aoiCrs;
  if (aoi.isGeoreferenced === false) summary.georeferenced = false;
  if (aoi.analyzedDimensions) summary.analyzedDimensions = aoi.analyzedDimensions;
  if (aoi.originalDimensions) summary.originalDimensions = aoi.originalDimensions;
  if (aoi.reason) summary.reason = clip(aoi.reason, 200);
  return summary;
}

/** Pull coverage numbers that make an index/area result interpretable. */
function summarizeCoverage(result) {
  if (!isPlainObject(result)) return null;
  // Real ML returns these flat on the result; the honest offline mocks nest
  // them under `coverage`. Accept both rather than losing the count.
  const source = isPlainObject(result.coverage) ? { ...result, ...result.coverage } : result;
  const coverage = {};
  const valid = source.valid_pixel_count ?? source.validPixelCount;
  const total = source.total_pixel_count ?? source.totalPixelCount;
  if (typeof valid === 'number') coverage.validPixels = valid;
  if (typeof total === 'number') coverage.totalPixels = total;
  if (typeof valid === 'number' && typeof total === 'number' && total > 0) {
    coverage.validPixelShare = Math.round((valid / total) * 1000) / 10;
  }
  if (typeof source.pixelCount === 'number') coverage.pixelCount = source.pixelCount;
  return Object.keys(coverage).length ? coverage : null;
}

/** Compact tool evidence: filenames, method names, notes — not raw dumps. */
function summarizeEvidence(evidence) {
  if (!isPlainObject(evidence)) return null;
  const out = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = clip(value, 120);
    } else if (Array.isArray(value)) {
      if (value.length <= MAX_EVIDENCE_ITEMS) {
        out[key] = value.slice(0, MAX_EVIDENCE_ITEMS).map(v => (typeof v === 'object' ? '[item]' : clip(String(v), 60)));
      } else {
        out[key] = `${value.length} item(s)`;
      }
    } else if (isPlainObject(value)) {
      const keys = Object.keys(value);
      out[key] = keys.length ? `object{${keys.slice(0, 4).join(', ')}}` : 'empty object';
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Build the compact context block handed to the LLM.
 *
 * Exported for testing: the composer must demonstrably receive evidence,
 * per-tool confidence, overall confidence, data quality and AOI status.
 */
export function buildAnswerContext(queryText, taskType, toolResults, context = {}) {
  const { confidence, confidenceSignals, qualityReport, degradation } = context;

  const tools = (toolResults || []).map(r => {
    const entry = {
      tool: r.tool,
      status: r.status
    };
    const toolConfidence = r.confidence ?? r.result?.confidence;
    if (typeof toolConfidence === 'number') entry.confidence = toolConfidence;
    if (r.status === 'failed' && (r.error || r.result?.error)) {
      entry.failureReason = clip(r.error || r.result?.error, 200);
    }
    const result = compactResult(r.result);
    if (result && Object.keys(result).length) entry.result = result;
    const evidence = summarizeEvidence(r.evidence);
    if (evidence) entry.evidence = evidence;
    const coverage = summarizeCoverage(r.result);
    if (coverage) entry.coverage = coverage;
    const aoi = summarizeAoi(r);
    if (aoi) entry.aoi = aoi;
    if (r.metadata?.mock) entry.mockData = true;
    return entry;
  });

  const compact = { userQuery: clip(queryText, 400), taskType, tools };

  if (typeof confidence === 'number') compact.overallConfidence = confidence;
  if (Array.isArray(confidenceSignals) && confidenceSignals.length) {
    compact.confidenceSignals = confidenceSignals.slice(0, 6).map(s => clip(s, 140));
  }

  if (isPlainObject(qualityReport)) {
    const quality = { status: qualityReport.status || null };
    if (qualityReport.summary) quality.summary = clip(qualityReport.summary, 240);
    if (Array.isArray(qualityReport.warnings) && qualityReport.warnings.length) {
      quality.warnings = qualityReport.warnings.slice(0, 5).map(w => clip(w, 180));
    }
    if (Array.isArray(qualityReport.checks)) {
      const failed = qualityReport.checks.filter(c => c && c.status !== 'PASS');
      if (failed.length) {
        quality.nonPassingChecks = failed.slice(0, 5).map(c => `${c.name}: ${c.status}${c.details ? ` — ${clip(c.details, 120)}` : ''}`);
      }
    }
    // Guard on the fields actually populated, so a checks-only report is not
    // silently dropped: a non-passing check is exactly what the model must see.
    if (quality.status || quality.summary || quality.warnings || quality.nonPassingChecks) {
      compact.dataQuality = quality;
    }
  }

  if (degradation) {
    compact.degradation = clip(degradation, 300);
  }

  return compact;
}

// ---------------------------------------------------------------------------
// Answer length policy
// ---------------------------------------------------------------------------

/**
 * Decide how much evidence the result actually contains. Length must be earned
 * by evidence, not granted by a token budget.
 */
export function assessAnswerRichness(toolResults) {
  const successes = (toolResults || []).filter(r => r.status === 'success');
  if (successes.length === 0) return { level: 'none', score: 0 };

  let score = successes.length; // more than one tool = more to reconcile
  for (const r of successes) {
    const result = r.result;
    if (!isPlainObject(result)) continue;
    const numeric = Object.values(result).filter(v => typeof v === 'number' && Number.isFinite(v)).length;
    score += Math.min(numeric, 5);
    if (summarizeCoverage(result)) score += 2;
    if (Array.isArray(result.series) || Array.isArray(result.observations)) score += 2;
    if (summarizeAoi(r)?.applied) score += 1;
    if (isPlainObject(r.evidence)) score += 1;
  }

  if (score >= 10) return { level: 'analytical', score };
  if (score >= 5) return { level: 'moderate', score };
  return { level: 'simple', score };
}

const LENGTH_POLICY = {
  analytical: {
    minWords: 180,
    maxWords: 350,
    instruction: 'Write a structured report of 180-350 words, using the section headings below as bolded leads.'
  },
  moderate: {
    minWords: 110,
    maxWords: 220,
    instruction: 'Write 110-220 words, using the section headings below as bolded leads.'
  },
  simple: {
    minWords: 25,
    maxWords: 80,
    instruction: 'Answer in 1-3 short sentences. Do not pad with headings or filler.'
  },
  none: {
    minWords: 20,
    maxWords: 80,
    instruction: 'State briefly that the analysis could not be completed and why, using only the reported failure reasons.'
  }
};

const SEMANTIC_CAVEAT =
  'A satellite measurement alone cannot establish semantic cause. If the result contains a candidate semantic ' +
  'interpretation, present it explicitly as a hypothesis consistent with the measured signal, not as an established ' +
  'fact, and note that confirmation requires ground truth or independent validation data that is not present.';

const ANTI_FABRICATION_RULES = [
  'Never state a number, percentage, area, pixel count, date or confidence that does not appear in the context above. ' +
  'If a value you would like to report is absent, say it was not reported.',
  'Never invent land-cover percentages, classifications, feature names, or building counts.',
  'Distinguish direct observation from inference. Label anything inferred as an inference.',
  'Do not claim ground truth. Remote-sensing inference is not verification.',
  'If the evidence is insufficient to answer part of the question, say so explicitly rather than estimating.',
  'If data quality checks did not pass, or the AOI was requested but not applied, state that limitation in the answer.'
];

function buildAnswerPrompt(queryText, taskType, toolResults, context = {}) {
  const structured = buildAnswerContext(queryText, taskType, toolResults, context);
  const richness = assessAnswerRichness(toolResults);
  const policy = LENGTH_POLICY[richness.level];
  const outline = outlineFor(taskType, toolResults);

  const outlineBlock = richness.level === 'simple' || richness.level === 'none'
    ? ''
    : `\nOrganize the answer around these sections, in this order:\n${outline.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`;

  const lead = TASK_LEADS[taskType];
  const multiTool = new Set(
    toolResults.filter(r => r && r.status === 'success' && r.tool).map(r => String(r.tool).toLowerCase())
  ).size > 1;
  // A multi-tool run adds a per-measurement instruction; it never replaces the
  // task lead, because that lead carries the thing the task is actually asking
  // for (e.g. optical and SAR evidence kept separate for a fusion answer).
  const leadText = multiTool
    ? `${lead ? `${lead} ` : ''}This query produced more than one measurement: answer the question directly in the first line, then give one clearly labelled statement per measurement.`
    : (lead || 'Answer the question directly, using only the measurements reported below.');

  return `You are the scientific reporting layer of SatQuery AI, an Earth-observation analysis system. Write the final answer a user sees for a satellite-im analysis query.

USER QUESTION
${structured.userQuery}

TASK TYPE
${taskType}

MEASURED CONTEXT (this is the complete set of facts you may use)
${JSON.stringify(structured, null, 2)}

WHAT THIS ANSWER MUST DO
${leadText}

ABSOLUTE RULES
${ANTI_FABRICATION_RULES.map(r => `- ${r}`).join('\n')}
- ${SEMANTIC_CAVEAT}

LENGTH
${policy.instruction}
Expand only because the context contains more reportable information. Do not restate the same number twice, and do not pad with filler.${outlineBlock}

Write the answer now.`;
}

// ---------------------------------------------------------------------------
// Honest degraded response (no LLM)
// ---------------------------------------------------------------------------

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function formatNumber(v) {
  if (!isFiniteNumber(v)) return null;
  return Math.round(v * 100) / 100;
}

/**
 * One factual line per successful tool: the measured value, nothing else.
 * This is deliberately extraction-only — it cannot interpret or embellish.
 */
function formatToolResult(r) {
  const result = r.result || {};

  // The offline placeholder is an explicit "nothing was computed" marker, not
  // an observation. Labelling it "Measured" would assert a measurement that
  // never happened, and would leak an internal token into user-facing prose.
  const isOfflinePlaceholder = v => typeof v === 'string' && v.trim().toLowerCase() === 'offline-placeholder';

  if (typeof result.answer === 'string' && result.answer && !isOfflinePlaceholder(result.answer)) {
    return `Measured answer: ${clip(result.answer, 200)}`;
  }
  if (typeof result.caption === 'string' && result.caption && !isOfflinePlaceholder(result.caption)) {
    return `Measured caption: ${clip(result.caption, 200)}`;
  }
  if (typeof result.summary === 'string' && result.summary) return `Reported summary: ${clip(result.summary, 200)}`;
  if (result.fusedLandCover) return `Fused classification output: ${JSON.stringify(result.fusedLandCover)}`;
  if (Array.isArray(result.series)) {
    const n = result.series.length;
    const slope = formatNumber(result.trendSlope ?? result.slope);
    return `Trend series with ${n} observation(s)${slope !== null ? `, slope ${slope}` : ''}.`;
  }
  if (Array.isArray(result.observations)) {
    return `Trend series with ${result.observations.length} observation(s).`;
  }

  // NDVI / NDWI — real ML returns `mean`; legacy fixtures used `value`.
  const indexValue = formatNumber(result.mean) ?? formatNumber(result.value);
  if (indexValue !== null) {
    const coverage = summarizeCoverage(result);
    const coverageText = coverage?.validPixels != null
      ? ` (${coverage.validPixels} valid pixel(s)${coverage.totalPixels != null ? ` of ${coverage.totalPixels}` : ''})`
      : '';
    return `${r.tool.toUpperCase()} value: ${indexValue}${coverageText}.`;
  }

  // CHANGE — real ML returns `change_percentage`; legacy used `changePercentage`.
  const changePct = formatNumber(result.change_percentage) ?? formatNumber(result.changePercentage);
  if (changePct !== null) {
    const parts = [`Change detected: ${changePct}%`];
    const meanDiff = formatNumber(result.mean_difference);
    const maxDiff = formatNumber(result.max_difference);
    const areaKm2 = formatNumber(result.changed_area_km2);
    if (meanDiff !== null) parts.push(`mean difference ${meanDiff}`);
    if (maxDiff !== null) parts.push(`max difference ${maxDiff}`);
    if (areaKm2 !== null) parts.push(`changed area ${areaKm2} km²`);
    return `${parts.join('; ')}.`;
  }

  // AREA — real ML returns area_km2/area_m2/area_ha; legacy used areaKm2.
  const km2 = formatNumber(result.area_km2) ?? formatNumber(result.areaKm2);
  if (km2 !== null) return `Calculated area: ${km2} km².`;
  const m2 = formatNumber(result.area_m2);
  if (m2 !== null) return `Calculated area: ${m2} m².`;
  const ha = formatNumber(result.area_ha);
  if (ha !== null) return `Calculated area: ${ha} ha.`;

  if (result.boundingBox) return `Feature located at bounding box: ${JSON.stringify(result.boundingBox)}.`;

  return `Raw result for "${r.tool}": ${clip(JSON.stringify(stripUnrenderable(result)), 200)}`;
}

function buildLimitationLines(toolResults, context) {
  const lines = [];
  const successes = (toolResults || []).filter(r => r.status === 'success');

  for (const r of toolResults || []) {
    if (r.status === 'failed') {
      lines.push(`Tool "${r.tool}" failed: ${clip(r.error || r.result?.error || r.metadata?.reason || 'reason not reported', 160)}`);
    } else if (r.status === 'skipped') {
      lines.push(`Tool "${r.tool}" was skipped: ${clip(r.error || 'dependency not satisfied', 160)}`);
    }
  }

  for (const r of successes) {
    const aoi = summarizeAoi(r);
    if (aoi?.requested && !aoi.applied) {
      lines.push(`A requested AOI was NOT applied to "${r.tool}" (${aoi.status || 'status not reported'})${aoi.reason ? `: ${aoi.reason}` : ''}`);
    }
    if (r.metadata?.mock) {
      lines.push(`Result for "${r.tool}" is labeled mock/offline data, not a real measurement.`);
    }
  }

  const warnings = context?.qualityReport?.warnings;
  if (Array.isArray(warnings) && warnings.length) {
    for (const w of warnings.slice(0, 3)) lines.push(`Data quality: ${clip(w, 160)}`);
  }

  if (lines.length === 0) {
    lines.push('Interpretation requires the configured language model; the values above are measurements only.');
  }
  return lines;
}

/**
 * Degraded, explicitly-labelled response used when no LLM is available.
 *
 * It must not read like a finished interpretation: it announces the degraded
 * mode first, then reports only what was measured, the evidence, the reported
 * confidence, and the limitations. It never infers meaning.
 */
export function buildFallbackAnswer(queryText, taskType, toolResults, context = {}) {
  const results = toolResults || [];
  const successes = results.filter(r => r.status === 'success');

  if (successes.length === 0) {
    const reasons = buildLimitationLines(results, context)
      .filter(l => l.startsWith('Tool'))
      .map(l => l.replace(/^Tool "[^"]+" failed: /, ''))
      .filter(Boolean);
    const reasonText = reasons.length ? ` Reported reasons: ${reasons.join('; ')}.` : '';
    return (
      'Detailed interpretation unavailable (LLM not configured).\n\n' +
      `The analysis for "${clip(queryText, 120)}" could not be completed.${reasonText}\n\n` +
      'No measurement was returned, so no value can be reported.'
    );
  }

  const measurements = successes.map(formatToolResult).filter(Boolean);
  const evidenceLines = [];
  for (const r of successes) {
    const ev = summarizeEvidence(r.evidence);
    if (ev) evidenceLines.push(`${r.tool}: ${Object.entries(ev).map(([k, v]) => `${k}=${v}`).join('; ')}`);
  }
  const coverageLines = successes
    .map(r => {
      const c = summarizeCoverage(r.result);
      return c ? `${r.tool}: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(', ')}` : null;
    })
    .filter(Boolean);
  const aoiLines = successes
    .map(r => {
      const a = summarizeAoi(r);
      if (!a || !a.requested) return null;
      // Include the pixel accounting: "AOI applied" alone reads like the whole
      // region was measured, which is not what a cropped window means.
      const parts = [`${r.tool}: AOI ${a.applied ? 'applied' : 'NOT applied'} (${a.scope || a.status || 'no scope'})`];
      if (a.validPixels != null) {
        parts.push(`validPixels=${a.validPixels}${a.maskedOutPixels != null ? `, maskedOutPixels=${a.maskedOutPixels}` : ''}`);
      }
      if (a.georeferenced === false) parts.push('raster is not georeferenced');
      if (a.reason) parts.push(`reason=${a.reason}`);
      return parts.join('; ');
    })
    .filter(Boolean);

  const confidence = context.confidence;
  const lines = ['Detailed interpretation unavailable (LLM not configured).', ''];

  lines.push('Measured result');
  for (const m of measurements) lines.push(`- ${m}`);

  if (coverageLines.length) {
    lines.push('', 'Pixel coverage');
    for (const c of coverageLines) lines.push(`- ${c}`);
  }
  if (aoiLines.length) {
    lines.push('', 'AOI scope');
    for (const a of aoiLines) lines.push(`- ${a}`);
  }
  if (evidenceLines.length) {
    lines.push('', 'Key evidence');
    for (const e of evidenceLines) lines.push(`- ${e}`);
  }

  lines.push('', 'Confidence');
  // A genuine 0 is a finding, not missing data: never render it as
  // "not reported", which would imply the pipeline simply omitted it.
  if (typeof confidence === 'number') {
    lines.push(
      `- Overall confidence: ${confidence} (heuristic, derived from validation and tool-reported confidence).`
    );
    if (confidence === 0) {
      lines.push('- Confidence is zero: treat every value below as unverified until the underlying data is checked.');
    }
  } else {
    lines.push('- Overall confidence: not reported by the pipeline.');
  }
  for (const r of successes) {
    const c = r.confidence ?? r.result?.confidence;
    if (typeof c === 'number') lines.push(`- ${r.tool} reported confidence: ${c}`);
  }

  lines.push('', 'Limitations');
  for (const l of buildLimitationLines(results, context)) lines.push(`- ${l}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// LLM invocation
// ---------------------------------------------------------------------------

async function callLlm(config, prompt, trace, maxTokens) {
  if (config.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: config.apiKey });
    const response = await client.messages.create({
      model: config.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    });
    return response.content.find(b => b.type === 'text')?.text || null;
  }

  const { default: OpenAI } = await import('openai');
  const isGroq = config.provider === 'groq';
  const baseURL = isGroq ? 'https://api.groq.com/openai/v1' : undefined;
  const client = new OpenAI({ apiKey: config.apiKey, baseURL });
  const response = await client.chat.completions.create({
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens
  });
  return response.choices[0]?.message?.content || null;
}

/**
 * Compose the final natural-language answer.
 *
 * @param {string} queryText
 * @param {string} taskType
 * @param {object[]} toolResults
 * @param {Array}  trace
 * @param {object} [context] { confidence, confidenceSignals, qualityReport, degradation }
 */
export async function composeAnswer(queryText, taskType, toolResults, trace, context = {}) {
  const pushed = trace || [];
  pushed.push(makeTraceEntry('answer_generation_start', 'Composing natural-language answer'));

  const config = resolveLlmConfig();
  const richness = assessAnswerRichness(toolResults);
  const policy = LENGTH_POLICY[richness.level];
  // Headroom for headings and markdown; never below the configured floor.
  const maxTokens = Math.max(1024, config.maxTokens);

  if (config.mocked) {
    const answer = buildFallbackAnswer(queryText, taskType, toolResults, context);
    pushed.push(makeTraceEntry('answer_generation', describeLlmMode(config, 'Answer generation', LLM_MODE.MOCK)));
    pushed.push(makeTraceEntry('answer_generation_detail',
      `Degraded factual response: ${answer.length} chars, evidence level "${richness.level}", no interpretation generated.`));
    return answer;
  }

  try {
    const prompt = buildAnswerPrompt(queryText, taskType, toolResults, context);
    const answerText = await callLlm(config, prompt, pushed, maxTokens);

    if (!answerText || !answerText.trim()) {
      const answer = buildFallbackAnswer(queryText, taskType, toolResults, {
        ...context,
        degradation: context.degradation || 'The LLM returned an empty response.'
      });
      pushed.push(makeTraceEntry('answer_generation', describeLlmMode(config, 'Answer generation', LLM_MODE.FALLBACK)));
      return answer;
    }

    pushed.push(makeTraceEntry('answer_generation', describeLlmMode(config, 'Answer generation', LLM_MODE.LLM)));
    pushed.push(makeTraceEntry('answer_generation_detail',
      `Requested ${policy.minWords}-${policy.maxWords} words (${maxTokens} max tokens, evidence level "${richness.level}"); generated ${answerText.trim().split(/\s+/).length} word(s).`));
    return answerText.trim();
  } catch (err) {
    console.warn('[AnswerComposer] LLM call failed, using fallback:', err.message);
    const answer = buildFallbackAnswer(queryText, taskType, toolResults, {
      ...context,
      degradation: context.degradation || `LLM call failed: ${err.message}`
    });
    pushed.push(makeTraceEntry('answer_generation', describeLlmMode(config, 'Answer generation', LLM_MODE.FALLBACK)));
    pushed.push(makeTraceEntry('answer_generation_detail',
      `Degraded factual response after failure: ${answer.length} chars. No interpretation was generated.`));
    return answer;
  }
}
