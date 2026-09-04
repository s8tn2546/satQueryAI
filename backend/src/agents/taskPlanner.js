import ToolRegistry from '../models/ToolRegistry.js';
import { makeTraceEntry } from '../utils/responseBuilder.js';

const DEFAULT_TASK_TOOL = 'vqa';

const TASK_TO_TOOL_NAMES = {
  VQA: ['vqa'],
  CAPTION: ['caption'],
  GROUNDING: ['ground'],
  CHANGE_ANALYSIS: ['change'],
  OPTICAL_SAR: ['optical_sar'],
  NDVI: ['ndvi'],
  NDWI: ['ndwi'],
  AREA: ['area'],
  TREND: ['trend'],
  FETCH_IMAGERY: ['fetch-imagery']
};

// Every tool the planner is allowed to emit. The ToolRegistry remains the source
// of truth: a name on this list that is not registered is still filtered out,
// so the planner can never generate an unregistered tool.
const KNOWN_TOOL_NAMES = new Set([
  'ndvi', 'ndwi', 'area', 'change', 'optical_sar', 'trend', 'fetch-imagery',
  'vqa', 'caption', 'ground', 'validate'
]);

const TOOL_REASONS = {
  'fetch-imagery': 'Acquire co-registered imagery for the requested region before analysis.',
  ndvi: 'Calculate the Normalized Difference Vegetation Index from the imagery.',
  ndwi: 'Calculate the Normalized Difference Water Index from the imagery.',
  change: 'Detect and describe changes between the available image pair.',
  area: 'Calculate the surface area of the detected feature or change.',
  optical_sar: 'Fuse optical and SAR imagery for cross-modal land-cover analysis.',
  trend: 'Analyze the historical time-series trend for the requested region and metric.',
  vqa: 'Answer the visual question about the image.',
  caption: 'Generate a descriptive caption of the image.',
  ground: 'Locate and highlight the requested feature in the image.',
  validate: 'Validate the image and extract structured metadata.'
};

function dedupe(names) {
  return [...new Set(names)];
}

function reasonFor(tool) {
  return TOOL_REASONS[tool] || `Run ${tool} analysis.`;
}

/**
 * Deterministically derive dependency edges between planned steps.
 *
 * Current rules:
 * - `fetch-imagery` runs first; every downstream analysis step depends on the
 *   imagery it produces (fetch-imagery -> analysis).
 * - when both `change` and `area` are planned, `area` depends on `change` so it
 *   measures the change result instead of inventing an unrelated input.
 */
function assignDependencies(steps) {
  const ranked = steps.map((s, i) => ({ ...s, __rank: i }));
  const firstIndex = new Map();
  ranked.forEach((s) => {
    if (!firstIndex.has(s.tool)) firstIndex.set(s.tool, s.__rank);
  });

  const fetchRank = firstIndex.get('fetch-imagery');
  if (fetchRank !== undefined) {
    for (const s of ranked) {
      if (s.__rank > fetchRank && s.tool !== 'fetch-imagery') {
        s.dependsOn.push('fetch-imagery');
      }
    }
  }

  const changeRank = firstIndex.get('change');
  const areaRank = firstIndex.get('area');
  if (changeRank !== undefined && areaRank !== undefined && areaRank > changeRank) {
    ranked[areaRank].dependsOn = ['change'];
  }

  return ranked.map(({ __rank, ...s }) => ({ ...s, dependsOn: dedupe(s.dependsOn) }));
}

/**
 * Build a deterministic, structured execution plan for a query.
 *
 * The planner ONLY builds the plan — it never executes a tool. Execution stays
 * in the pipeline/toolExecutor. Registered tools come from the ToolRegistry
 * (source of truth); unregistered suggestions are dropped.
 *
 * @param {string} taskType
 * @param {string[]} [suggestedToolNames] tool names suggested by intent classification
 * @param {Array} [trace] execution trace to annotate
 * @returns {Promise<{ taskType: string, steps: Array<{ order: number, tool: string, reason: string, dependsOn: string[] }> }>}
 */
export async function buildPlan(taskType, suggestedToolNames = [], trace) {
  const desired = suggestedToolNames.length > 0
    ? dedupe(suggestedToolNames)
    : dedupe(TASK_TO_TOOL_NAMES[taskType] || [DEFAULT_TASK_TOOL]);

  const candidates = desired.filter(name => KNOWN_TOOL_NAMES.has(name));

  const registered = await ToolRegistry.find({ name: { $in: candidates } });
  const registeredNames = new Set(registered.map(t => t.name));

  let steps = candidates
    .filter(name => registeredNames.has(name))
    .map(name => ({
      order: 0,
      tool: name,
      reason: reasonFor(name),
      dependsOn: []
    }));

  if (steps.length === 0) {
    const fallbackName = (TASK_TO_TOOL_NAMES[taskType] && TASK_TO_TOOL_NAMES[taskType][0]) || DEFAULT_TASK_TOOL;
    const fallback = await ToolRegistry.findOne({ name: fallbackName });
    if (fallback && KNOWN_TOOL_NAMES.has(fallbackName)) {
      steps = [{ order: 0, tool: fallbackName, reason: reasonFor(fallbackName), dependsOn: [] }];
    }
  }

  const plan = {
    taskType,
    steps: assignDependencies(steps).map((s, idx) => ({ ...s, order: idx + 1 }))
  };

  if (trace) {
    trace.push(makeTraceEntry('task_planning', `Planned ${plan.steps.length} step(s): [${plan.steps.map(s => s.tool).join(', ')}]`));
  }

  return plan;
}

/**
 * Resolve a plan into the registered tool documents the executor consumes.
 *
 * Kept as the pipeline-facing entry point so execution stays in the existing
 * toolExecutor/pipeline architecture. The structured plan is attached to the
 * returned array (non-enumerably) so callers can inspect it without changing
 * the tools-array contract used by executeTools.
 */
export async function planTools(taskType, suggestedToolNames, trace) {
  const plan = await buildPlan(taskType, suggestedToolNames, trace);
  const tools = [];

  for (const name of plan.steps.map(s => s.tool)) {
    const tool = await ToolRegistry.findOne({ name });
    if (tool) tools.push(tool);
  }

  if (tools.length === 0) {
    const fallbackName = (TASK_TO_TOOL_NAMES[taskType] && TASK_TO_TOOL_NAMES[taskType][0]) || DEFAULT_TASK_TOOL;
    const fallback = await ToolRegistry.findOne({ name: fallbackName });
    if (fallback) tools.push(fallback);
  }

  Object.defineProperty(tools, 'plan', { value: plan, enumerable: false, configurable: true });

  trace.push(makeTraceEntry('tool_selection', `Selected tools: [${tools.map(t => t.name).join(', ')}]`));
  return tools;
}
