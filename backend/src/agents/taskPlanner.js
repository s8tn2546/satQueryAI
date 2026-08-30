import ToolRegistry from '../models/ToolRegistry.js';
import { makeTraceEntry } from '../utils/responseBuilder.js';

const TASK_TO_TOOL_NAMES = {
  VQA: ['vqa'],
  CAPTION: ['caption'],
  GROUNDING: ['ground'],
  CHANGE_ANALYSIS: ['change'],
  OPTICAL_SAR: ['optical_sar'],
  NDVI: ['ndvi'],
  NDWI: ['ndwi'],
  AREA: ['area'],
  TREND: ['trend']
};

export async function planTools(taskType, suggestedToolNames, trace) {
  const toolNames = (suggestedToolNames && suggestedToolNames.length > 0)
    ? suggestedToolNames
    : (TASK_TO_TOOL_NAMES[taskType] || ['vqa']);

  const tools = [];
  for (const name of toolNames) {
    const tool = await ToolRegistry.findOne({ name });
    if (tool) {
      tools.push(tool);
    } else {
      console.warn(`[TaskPlanner] Tool "${name}" not found in registry; skipping.`);
    }
  }

  if (tools.length === 0) {
    const fallbackName = TASK_TO_TOOL_NAMES[taskType]?.[0] || 'vqa';
    const fallback = await ToolRegistry.findOne({ name: fallbackName });
    if (fallback) tools.push(fallback);
  }

  trace.push(makeTraceEntry('tool_selection', `Selected tools: [${tools.map(t => t.name).join(', ')}]`));
  return tools;
}
