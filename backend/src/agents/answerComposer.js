import Anthropic from '@anthropic-ai/sdk';
import { makeTraceEntry } from '../utils/responseBuilder.js';

function buildAnswerPrompt(queryText, taskType, toolResults) {
  const resultSummary = toolResults.map(r => {
    return `Tool: ${r.tool}\nStatus: ${r.status}\nResult: ${JSON.stringify(r.result || {}, null, 2)}`;
  }).join('\n---\n');

  return `You are answering a satellite image analysis query on behalf of SatQuery AI.

User query: "${queryText}"
Task type: ${taskType}

Tool results:
${resultSummary}

Rules:
- Only use facts, numbers, and claims that appear in the tool results above.
- Do NOT invent, infer, or embellish any number, percentage, or claim not present in the results.
- Be concise and direct.
- If all tools failed, state clearly that the analysis could not be completed and why.

Provide a natural-language answer to the user's query based strictly on the tool results.`;
}

function buildFallbackAnswer(queryText, taskType, toolResults) {
  const successful = toolResults.filter(r => r.status === 'success');
  if (successful.length === 0) {
    return `The analysis for your query could not be completed. The image processing service returned no results. Please check your uploaded images and try again.`;
  }

  const r = successful[0];
  const result = r.result || {};

  if (result.answer) return result.answer;
  if (result.caption) return result.caption;
  if (result.summary) return result.summary;
  if (result.fusedLandCover) return `Fused analysis result: ${JSON.stringify(result.fusedLandCover)}`;
  if (typeof result.value === 'number') return `${r.tool.toUpperCase()} value: ${result.value}`;
  if (result.series) return `Trend analysis returned ${result.series.length} data point(s).`;
  if (result.changePercentage !== undefined) return `Change detected: ${result.changePercentage}% change. ${result.summary || ''}`;
  if (result.areaKm2 !== undefined) return `Calculated area: ${result.areaKm2} km².`;
  if (result.boundingBox) return `Feature located at bounding box: ${JSON.stringify(result.boundingBox)}.`;

  return `Analysis complete. Result: ${JSON.stringify(result)}`;
}

export async function composeAnswer(queryText, taskType, toolResults, trace) {
  trace.push(makeTraceEntry('answer_generation_start', 'Composing natural-language answer'));

  const llmApiKey = process.env.LLM_API_KEY;
  const llmProvider = process.env.LLM_PROVIDER || 'anthropic';
  const isMock = !llmApiKey || llmApiKey === 'mock-llm-key' || llmApiKey.startsWith('mock');

  if (isMock) {
    const answer = buildFallbackAnswer(queryText, taskType, toolResults);
    trace.push(makeTraceEntry('answer_generation', '[mock] Answer composed from tool result'));
    return answer;
  }

  try {
    let answerText;

    const prompt = buildAnswerPrompt(queryText, taskType, toolResults);

    if (llmProvider === 'anthropic') {
      const client = new Anthropic({ apiKey: llmApiKey });
      const response = await client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }]
      });
      answerText = response.content.find(b => b.type === 'text')?.text || buildFallbackAnswer(queryText, taskType, toolResults);
    } else {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: llmApiKey });
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512
      });
      answerText = response.choices[0]?.message?.content || buildFallbackAnswer(queryText, taskType, toolResults);
    }

    trace.push(makeTraceEntry('answer_generation', 'Answer composed via LLM'));
    return answerText;
  } catch (err) {
    console.warn('[AnswerComposer] LLM call failed, using fallback:', err.message);
    const answer = buildFallbackAnswer(queryText, taskType, toolResults);
    trace.push(makeTraceEntry('answer_generation', '[fallback] Answer composed from tool result'));
    return answer;
  }
}
