import Anthropic from '@anthropic-ai/sdk';
import { makeTraceEntry } from '../utils/responseBuilder.js';

const TASK_TYPES = ['VQA', 'CAPTION', 'GROUNDING', 'CHANGE_ANALYSIS', 'OPTICAL_SAR', 'NDVI', 'NDWI', 'AREA', 'TREND'];

const OUT_OF_SCOPE_TASK = 'OUT_OF_SCOPE';

const TOOL_DEFINITIONS = [
  {
    name: 'classify_query',
    description: 'Classify a satellite image query into a task type and extract any relevant parameters.',
    input_schema: {
      type: 'object',
      properties: {
        taskType: {
          type: 'string',
          enum: [...TASK_TYPES, OUT_OF_SCOPE_TASK],
          description: 'The task type that best matches the user query. Use OUT_OF_SCOPE if the query cannot be answered by any supported task.'
        },
        toolNames: {
          type: 'array',
          items: { type: 'string', enum: ['vqa', 'caption', 'ground', 'change', 'optical_sar', 'ndvi', 'ndwi', 'area', 'trend', 'fetch-imagery'] },
          description: 'Ordered list of tool names needed, in execution order. Combine tools requested together: ["ndvi","ndwi"] when both are requested, ["fetch-imagery","ndvi"] when imagery must be acquired before analysis, ["change","area"] when the changed area must be measured. Single-tool examples: ["vqa"], ["caption"], ["change"], ["optical_sar"], ["area"], ["trend"].'
        },
        parameters: {
          type: 'object',
          description: 'Extracted parameters: question (for VQA), target (for GROUNDING), region (GeoJSON or name), metric (for TREND/NDVI/NDWI), startDate, endDate, featureType, fusionMethod.',
          properties: {
            question: { type: 'string' },
            target: { type: 'string' },
            region: {},
            metric: { type: 'string' },
            startDate: { type: 'string' },
            endDate: { type: 'string' },
            featureType: { type: 'string' },
            fusionMethod: { type: 'string' }
          }
        }
      },
      required: ['taskType', 'toolNames', 'parameters']
    }
  }
];

function buildSystemPrompt(imageCount, modalities) {
  return `You are an intent classifier for SatQuery AI, a satellite image analysis system.

Supported tasks:
- VQA: Answer a specific question about a single satellite image
- CAPTION: Generate a descriptive caption of a single satellite image
- GROUNDING: Highlight or locate a specific feature/object in a single satellite image
- CHANGE_ANALYSIS: Detect and describe changes between two images from different dates
- OPTICAL_SAR: Fuse optical and SAR satellite imagery to identify land cover / water
- NDVI: Calculate vegetation index (requires optical image)
- NDWI: Calculate water index (requires optical image)
- AREA: Calculate surface area of identified features
- TREND: Analyze historical time-series trend for a region and metric
- FETCH_IMAGERY: Acquire imagery for a region before running analysis tools

When the user requests more than one capability, return them together in
execution order. Examples:
- "calculate NDVI and NDWI" -> toolNames: ["ndvi", "ndwi"]
- "fetch imagery and calculate NDVI" -> toolNames: ["fetch-imagery", "ndvi"]
- "compare images and calculate the changed area" -> toolNames: ["change", "area"]

Context: The user has provided ${imageCount} image(s) with modalities: ${modalities.join(', ') || 'unknown'}.

Classify the query, select the appropriate tool(s), and extract any relevant parameters.
If the query is not answerable by any supported task, use OUT_OF_SCOPE.`;
}

function mockClassify(queryText, imageCount) {
  const q = queryText.toLowerCase();

  // ---- Deterministic multi-tool detection (explicit combined intent) ----
  const explicitFetch = /(?:^|\b)(fetch|acquire|download|pull)\b.{0,25}\bimager/i.test(q);
  const wantsNdvI = /(^|[^a-z])ndvi([^a-z]|$)|vegetation index/i.test(q);
  const wantsNdwI = /(^|[^a-z])ndwi([^a-z]|$)|water index/i.test(q);
  const wantsChange = /changed|bi-temporal|between (these|the) two|built-up area|increased|decreased/.test(q);
  const wantsOpticalSar = /optical.{0,20}sar|sar.{0,20}optical|fus(e|ion)/.test(q);
  const wantsArea = /changed area|area\s+of\s+(the\s+)?change|(calculate|measure|compute|estimate)\b.{0,30}\b(surface\s+)?area\b/.test(q);
  const wantsTrend = /historical trend|trend over|time series/.test(q);

  const TASK_FOR_TOOL = {
    ndvi: 'NDVI',
    ndwi: 'NDWI',
    optical_sar: 'OPTICAL_SAR',
    change: 'CHANGE_ANALYSIS',
    area: 'AREA',
    trend: 'TREND'
  };

  // NDVI + NDWI requested together ("calculate NDVI and NDWI").
  if (wantsNdvI && wantsNdwI) {
    return { taskType: 'NDVI', toolNames: ['ndvi', 'ndwi'], parameters: {} };
  }

  // Acquisition explicitly requested ahead of one or more analysis tools.
  const acquisitionTools = [];
  if (wantsNdvI) acquisitionTools.push('ndvi');
  if (wantsNdwI) acquisitionTools.push('ndwi');
  if (wantsOpticalSar) acquisitionTools.push('optical_sar');
  if (wantsChange) acquisitionTools.push('change');
  if (wantsArea) acquisitionTools.push('area');
  if (wantsTrend) acquisitionTools.push('trend');

  if (explicitFetch && acquisitionTools.length > 0) {
    return {
      taskType: TASK_FOR_TOOL[acquisitionTools[0]],
      toolNames: ['fetch-imagery', ...acquisitionTools],
      parameters: {}
    };
  }

  // change detection followed by area calculation ("compute the changed area").
  if (wantsChange && wantsArea) {
    return { taskType: 'CHANGE_ANALYSIS', toolNames: ['change', 'area'], parameters: {} };
  }

  // ---- Single-tool classification ----
  if (q.includes('caption') || q.includes('describe') || q.includes('land-cover') || q.includes('land cover') || q.includes('visible')) {
    return { taskType: 'CAPTION', toolNames: ['caption'], parameters: {} };
  }
  if (q.includes('highlight') || q.includes('locate') || q.includes('ground') || q.includes('where is') || q.includes('find the')) {
    const targetMatch = q.match(/highlight (?:the )?(.+?) (?:referred|in|on)/i);
    return { taskType: 'GROUNDING', toolNames: ['ground'], parameters: { target: targetMatch?.[1] || 'feature' } };
  }
  if (q.includes('changed') || q.includes('change') || q.includes('between these two') || q.includes('bi-temporal') || q.includes('built-up area') || q.includes('increased') || q.includes('decreased')) {
    return { taskType: 'CHANGE_ANALYSIS', toolNames: ['change'], parameters: {} };
  }
  if (q.includes('optical') && q.includes('sar') || q.includes('fus') || q.includes('built-up and water')) {
    return { taskType: 'OPTICAL_SAR', toolNames: ['optical_sar'], parameters: {} };
  }
  if (q.includes('ndvi') || q.includes('vegetation index')) {
    return { taskType: 'NDVI', toolNames: ['ndvi'], parameters: {} };
  }
  if (q.includes('ndwi') || q.includes('water index')) {
    return { taskType: 'NDWI', toolNames: ['ndwi'], parameters: {} };
  }
  if (q.includes('area') || q.includes('surface area') || q.includes('how large') || q.includes('how big')) {
    return { taskType: 'AREA', toolNames: ['area'], parameters: {} };
  }
  if (q.includes('trend') || q.includes('historical') || q.includes('time series') || q.includes('over time')) {
    return { taskType: 'TREND', toolNames: ['trend'], parameters: {} };
  }
  return { taskType: 'VQA', toolNames: ['vqa'], parameters: { question: queryText } };
}

export async function classifyIntent(queryText, tiles, trace) {
  const imageCount = tiles.length;
  const modalities = [...new Set(tiles.map(t => t.modality).filter(Boolean))];

  trace.push(makeTraceEntry('intent_classification_start', `Classifying query with ${imageCount} image(s)`));

  const llmApiKey = process.env.LLM_API_KEY;
  const llmProvider = process.env.LLM_PROVIDER || 'anthropic';

  const isMock = !llmApiKey || llmApiKey === 'mock-llm-key' || llmApiKey.startsWith('mock');

  if (isMock) {
    const result = mockClassify(queryText, imageCount);
    trace.push(makeTraceEntry('intent_classification', `[mock] Classified as ${result.taskType}, tools: [${result.toolNames.join(', ')}]`));
    return result;
  }

  try {
    let classified;

    if (llmProvider === 'anthropic') {
      const client = new Anthropic({ apiKey: llmApiKey });
      const response = await client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 512,
        system: buildSystemPrompt(imageCount, modalities),
        tools: TOOL_DEFINITIONS,
        tool_choice: { type: 'any' },
        messages: [{ role: 'user', content: queryText }]
      });

      const toolUse = response.content.find(b => b.type === 'tool_use');
      if (!toolUse) throw new Error('LLM did not return a tool_use block');
      classified = toolUse.input;
    } else {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: llmApiKey });
      const openaiTools = TOOL_DEFINITIONS.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema }
      }));
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: buildSystemPrompt(imageCount, modalities) },
          { role: 'user', content: queryText }
        ],
        tools: openaiTools,
        tool_choice: { type: 'function', function: { name: 'classify_query' } }
      });
      const call = response.choices[0]?.message?.tool_calls?.[0];
      if (!call) throw new Error('LLM did not return a function call');
      classified = JSON.parse(call.function.arguments);
    }

    trace.push(makeTraceEntry('intent_classification', `Classified as ${classified.taskType}, tools: [${classified.toolNames.join(', ')}]`));
    return classified;
  } catch (err) {
    console.warn('[IntentClassifier] LLM call failed, falling back to heuristic:', err.message);
    const result = mockClassify(queryText, imageCount);
    trace.push(makeTraceEntry('intent_classification', `[heuristic-fallback] Classified as ${result.taskType}, tools: [${result.toolNames.join(', ')}]`));
    return result;
  }
}
