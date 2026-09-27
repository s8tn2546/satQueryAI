/**
 * Tests for the final-answer prompt and the degraded answer contract.
 *
 * `buildAnswerPrompt` is internal, so the prompt is captured the way it
 * actually ships: by intercepting the LLM client with a real-looking key.
 */
import { jest } from '@jest/globals';

const REAL_KEY = 'sk-real-abcdef0123456789';

/** Captures the prompt the composer would send, and returns a canned answer. */
function interceptPrompt(reply = 'A stub answer.') {
  const captured = {};
  const spy = jest.fn().mockImplementation(async (params) => {
    captured.system = params.system;
    captured.messages = JSON.stringify(params.messages);
    captured.maxTokens = params.max_tokens;
    return { content: [{ type: 'text', text: reply }] };
  });
  return { spy, captured };
}

// These tests need a real-looking key so the composer takes the live LLM path
// and the stub client is exercised. The env is restored in afterAll: Jest can
// run several test files in one worker, and a leaked real-looking key would
// make unrelated suites attempt genuine network calls.
const savedEnv = {};
let composeAnswer;

beforeAll(async () => {
  for (const k of ['GROQ_API_KEY', 'LLM_API_KEY', 'LLM_PROVIDER']) savedEnv[k] = process.env[k];
  process.env.GROQ_API_KEY = '';
  process.env.LLM_API_KEY = REAL_KEY;
  process.env.LLM_PROVIDER = 'anthropic';
  ({ composeAnswer } = await import('../src/agents/answerComposer.js'));
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let _promptSpy = interceptPrompt();
let _promptCaptured = _promptSpy.captured;

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: _promptSpy } }))
}));

function res(tool, result, status = 'success', extra = {}) {
  return { tool, status, result, confidence: status === 'success' ? 0.9 : 0, ...extra };
}

beforeEach(() => {
  const fresh = interceptPrompt();
  _promptSpy = fresh.spy;
  _promptCaptured = fresh.captured;
});

/** Run the composer and return the answer plus the prompt it actually sent. */
async function composeWithCapturedPrompt({ question, taskType, toolResults, context, reply }) {
  if (reply !== undefined) {
    _promptSpy.mockImplementation(async (params) => {
      _promptCaptured.system = params.system;
      _promptCaptured.messages = JSON.stringify(params.messages);
      _promptCaptured.maxTokens = params.max_tokens;
      return { content: [{ type: 'text', text: reply }] };
    });
  }
  const answer = await composeAnswer(question, taskType, toolResults, [], context);
  return {
    answer,
    prompt: `${_promptCaptured.system}\n${_promptCaptured.messages}`,
    maxTokens: _promptCaptured.maxTokens
  };
}

describe('answer prompt — anti-fabrication', () => {
  test('states that the context is the only permitted source of facts', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'Is the area flooding?',
      taskType: 'VQA',
      toolResults: [res('vqa', { answer: 'yes' })]
    });

    expect(prompt).toMatch(/complete set of facts you may use/i);
    expect(prompt).toMatch(/do not invent|never invent|must not fabricate/i);
    expect(prompt).toMatch(/undefined|null|NaN/i);
  });

  test('forbids claiming values the tools did not return', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'What is the NDVI?',
      taskType: 'NDVI',
      toolResults: [res('ndvi', { mean: 0.42 })]
    });
    expect(prompt).toMatch(/does not appear in the context/i);
  });

  test('a change answer is told not to assert cause from a measurement', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'What changed here?',
      taskType: 'CHANGE_ANALYSIS',
      toolResults: [res('change', { change_percentage: 12 })]
    });
    // A detected signal is not a cause: the caveat must be present.
    expect(prompt).toMatch(/cannot establish semantic cause/i);
    expect(prompt).toMatch(/hypothesis/i);
  });

  test('an optical-SAR fusion answer is told to separate the modalities', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'Fuse optical and radar?',
      taskType: 'OPTICAL_SAR',
      toolResults: [
        res('ndvi', { mean: 0.4 }),
        res('sar', { mean_backscatter: -12 })
      ]
    });
    expect(prompt).toMatch(/separately/i);
    expect(prompt).toMatch(/optical/i);
    expect(prompt).toMatch(/sar/i);
  });
});

describe('answer prompt — carries the real evidence', () => {
  test('includes the measured value, coverage and confidence', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'What is the NDVI?',
      taskType: 'NDVI',
      toolResults: [res('ndvi', {
        mean: 0.42,
        coverage: { valid_pixel_count: 1200, total_pixel_count: 1600 }
      })],
      context: { confidence: 0.8, confidenceSignals: ['+0.1: georeferenced raster'] }
    });

    expect(prompt).toContain('0.42');
    expect(prompt).toContain('1200');
    expect(prompt).toContain('0.8');
    expect(prompt).toMatch(/valid[_ ]pixel[_ ]?count/i);
  });

  test('includes the original user question verbatim', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'How much did the river flood?',
      taskType: 'VQA',
      toolResults: [res('vqa', { answer: 'yes' })]
    });
    expect(prompt).toContain('How much did the river flood?');
  });

  test('includes the AOI scope so the answer cannot overstate the region', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'What changed?',
      taskType: 'CHANGE_ANALYSIS',
      toolResults: [res('change', { change_percentage: 12 }, 'success', {
        metadata: { aoi: { aoiApplied: true, aoiScope: 'raster_window+mask', validPixels: 900, maskedOutPixels: 60 } }
      })],
      context: { aoiRequested: true }
    });

    expect(prompt).toMatch(/raster_window\+mask/);
    expect(prompt).toContain('900');
    expect(prompt).toMatch(/aoi|region of interest/i);
  });

  test('surfaces a failed tool instead of hiding it', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'NDVI and NDWI?',
      taskType: 'CHANGE_ANALYSIS',
      toolResults: [res('ndvi', { mean: 0.5 }), res('ndwi', {}, 'failed', { error: 'band missing' })]
    });
    expect(prompt).toMatch(/failed/i);
    expect(prompt).toMatch(/band missing/);
  });

  test('passes the data-quality report to the model', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'What is here?',
      taskType: 'VQA',
      toolResults: [res('vqa', { answer: 'yes' })],
      context: { qualityReport: { checks: [{ name: 'crs', status: 'warn', details: 'unreferenced png' }] } }
    });
    expect(prompt).toMatch(/unreferenced png/);
  });
});

describe('answer prompt — task-conditioned structure', () => {
  test('asks for change before/after and magnitude', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'What changed?',
      taskType: 'CHANGE_ANALYSIS',
      toolResults: [res('change', { change_percentage: 12, mean_difference: 0.04, max_difference: 0.2 })]
    });
    expect(prompt.toLowerCase()).toContain('change');
    expect(prompt).toMatch(/by how much|magnitude/i);
  });

  test('asks for a plain statement for a simple single-value question', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'What is the NDVI?',
      taskType: 'NDVI',
      toolResults: [res('ndvi', { mean: 0.42 })]
    });
    // A single number must not be dressed up as a report.
    expect(prompt).toMatch(/plain|direct|one sentence|short/i);
    expect(prompt).not.toMatch(/## 1\./);
  });

  test('gives a trend answer a time-ordering instruction', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'How is NDVI changing?',
      taskType: 'TREND',
      toolResults: [res('trend', { series: [0.1, 0.2, 0.35] })]
    });
    expect(prompt).toMatch(/direction of change over time/i);
  });
});

describe('answer length scales with the evidence', () => {
  test('a single number is not given a report outline', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'What is the NDVI?',
      taskType: 'NDVI',
      toolResults: [res('ndvi', { mean: 0.42 })]
    });
    expect(prompt).not.toMatch(/Organize the answer around these sections/);
  });

  test('a rich multi-tool result is given a section outline', async () => {
    const { prompt } = await composeWithCapturedPrompt({
      question: 'Give me a full picture of change and vegetation',
      taskType: 'CHANGE_ANALYSIS',
      toolResults: [
        res('change', { change_percentage: 12, mean_difference: 0.04, max_difference: 0.2 }),
        res('ndvi', { mean: 0.42, coverage: { valid_pixel_count: 900, total_pixel_count: 1000 } }),
        res('ndwi', { mean: 0.31, coverage: { valid_pixel_count: 900, total_pixel_count: 1000 } })
      ]
    });
    expect(prompt).toMatch(/Organize the answer around these sections/);
    // The numbered outline must be rendered, not left as an empty list.
    expect(prompt).toMatch(/1\.\s+\S/);
  });

  test('a rich result asks for a longer answer than a bare value', async () => {
    const short = await composeWithCapturedPrompt({
      question: 'What is the NDVI?',
      taskType: 'NDVI',
      toolResults: [res('ndvi', { mean: 0.42 })]
    });
    const rich = await composeWithCapturedPrompt({
      question: 'Full picture of change and vegetation health',
      taskType: 'CHANGE_ANALYSIS',
      toolResults: [
        res('change', { change_percentage: 12, mean_difference: 0.04, max_difference: 0.2 }),
        res('ndvi', { mean: 0.42, coverage: { valid_pixel_count: 900, total_pixel_count: 1000 } }),
        res('ndwi', { mean: 0.31, coverage: { valid_pixel_count: 900, total_pixel_count: 1000 } })
      ]
    });
    expect(rich.prompt).not.toBe(short.prompt);
  });
});

describe('degraded answers stay honest', () => {
  test('a real LLM answer is returned unchanged', async () => {
    const { answer } = await composeWithCapturedPrompt({
      question: 'What is here?',
      taskType: 'VQA',
      toolResults: [res('vqa', { answer: 'yes' })],
      reply: 'The scene shows cropland with a river along the south edge.'
    });
    expect(answer).toBe('The scene shows cropland with a river along the south edge.');
    expect(answer).not.toMatch(/unavailable/i);
  });

  test('an LLM failure produces a labelled degraded answer, not an error', async () => {
    _promptSpy.mockRejectedValue(new Error('upstream 529'));
    const answer = await composeAnswer('What is the NDVI?', 'NDVI', [res('ndvi', { mean: 0.42 })], []);

    expect(answer).toMatch(/unavailable/i);
    expect(answer).toContain('0.42');
    expect(answer).toMatch(/limitations/i);
  });

  test('a degraded answer is returned even when the LLM returns junk', async () => {
    const { answer } = await composeWithCapturedPrompt({
      question: 'What is here?',
      taskType: 'VQA',
      toolResults: [res('vqa', { answer: 'yes' })],
      reply: '   '
    });
    expect(answer).toMatch(/unavailable|measured/i);
  });
});
