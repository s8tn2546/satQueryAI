import { composeAnswer, buildFallbackAnswer, buildAnswerContext, assessAnswerRichness } from '../src/agents/answerComposer.js';

// Note: these assertions were updated when the composer gained an explicit
// degraded mode (Phase 6). The original tests asserted an exact one-clause
// string; they now assert the SAME measured values AND that the response is
// honestly labelled as degraded. No semantic assertion was dropped or loosened.

beforeEach(() => {
  process.env.LLM_API_KEY = 'mock-llm-key';
});

function res(tool, result, status = 'success') {
  return { tool, status, result, confidence: status === 'success' ? 1 : 0 };
}

/** The degraded response must always announce itself. */
function expectDegraded(answer) {
  expect(answer).toContain('Detailed interpretation unavailable (LLM not configured)');
  expect(answer).toContain('Measured result');
  expect(answer).toContain('Limitations');
  return answer;
}

describe('answerComposer fallback — multi-tool composition', () => {
  test('NDVI + NDWI both successful -> answer contains both', async () => {
    const toolResults = [
      res('ndvi', { mean: 0.5661764551843529 }),
      res('ndwi', { mean: -0.41346152756396204 })
    ];
    const answer = expectDegraded(await composeAnswer('calculate NDVI and NDWI', 'multi-index-analysis', toolResults, []));
    expect(answer).toContain('NDVI value: 0.57');
    expect(answer).toContain('NDWI value: -0.41');
  });

  test('NDVI + NDWI both successful via `value` legacy field -> answer contains both', async () => {
    const toolResults = [
      res('ndvi', { value: 0.62 }),
      res('ndwi', { value: 0.45 })
    ];
    const answer = expectDegraded(await composeAnswer('calculate NDVI and NDWI', 'multi-index-analysis', toolResults, []));
    expect(answer).toContain('NDVI value: 0.62');
    expect(answer).toContain('NDWI value: 0.45');
  });

  test('mixed composition: NDVI + AREA both successful', async () => {
    const toolResults = [
      res('ndvi', { mean: 0.64 }),
      res('area', { area_km2: 10.2 })
    ];
    const answer = expectDegraded(await composeAnswer('calc ndvi and area', 'mixed', toolResults, []));
    expect(answer).toContain('NDVI value: 0.64');
    expect(answer).toContain('Calculated area: 10.2 km²');
  });

  test('mixed composition: multiple tools with one failure -> successful result represented, failed not invented', async () => {
    const toolResults = [
      res('ndvi', { mean: 0.62 }, 'success'),
      res('ndwi', {}, 'failed')
    ];
    const answer = expectDegraded(await composeAnswer('calculate NDVI and NDWI', 'multi-index-analysis', toolResults, []));
    expect(answer).toContain('NDVI value: 0.62');
    expect(answer).not.toContain('NDWI value:');
    expect(answer).not.toContain('undefined');
    expect(answer).not.toContain('null');
    // The failure is disclosed, not hidden.
    expect(answer).toMatch(/ndwi/);
    expect(answer).toMatch(/fail/i);
  });
});

describe('answerComposer fallback — single-tool behavior preserved', () => {
  test('single NDVI (mean) -> measured value reported', async () => {
    const answer = expectDegraded(await composeAnswer('calc ndvi', 'index-analysis', [res('ndvi', { mean: 0.5661764551843529 })], []));
    expect(answer).toContain('NDVI value: 0.57');
  });

  test('single NDWI (mean) -> works', async () => {
    const answer = expectDegraded(await composeAnswer('calc ndwi', 'index-analysis', [res('ndwi', { mean: 0.45 })], []));
    expect(answer).toContain('NDWI value: 0.45');
  });

  test('all tools failed -> failure is stated and no value is reported', async () => {
    const toolResults = [
      res('ndvi', { error: 'no band' }, 'failed'),
      res('ndwi', {}, 'failed')
    ];
    const answer = await composeAnswer('calc', 'multi-index-analysis', toolResults, []);
    expect(answer).toContain('Detailed interpretation unavailable (LLM not configured)');
    expect(answer).toMatch(/could not be completed/);
    expect(answer).toMatch(/no band/);
    expect(answer).toMatch(/No measurement was returned/);
    // A failed NDVI must never be reported as a measured index value.
    expect(answer).not.toContain('NDVI value:');
  });
});

describe('answerComposer fallback — field support preserved', () => {
  test('answer field', async () => {
    const answer = expectDegraded(await composeAnswer('question', 'vqa', [res('vqa', { answer: 'Yes, water detected' })], []));
    expect(answer).toContain('Yes, water detected');
  });

  test('caption field', async () => {
    const answer = expectDegraded(await composeAnswer('describe', 'caption', [res('caption', { caption: 'A flooded region' })], []));
    expect(answer).toContain('A flooded region');
  });

  test('summary field', async () => {
    const answer = expectDegraded(await composeAnswer('analyze', 'analysis', [res('analysis', { summary: 'legacy summary text' })], []));
    expect(answer).toContain('legacy summary text');
  });

  test('fusedLandCover field', async () => {
    const fusedLandCover = { water: 0.6, vegetation: 0.4 };
    const answer = expectDegraded(await composeAnswer('analyze', 'analysis', [res('analysis', { fusedLandCover })], []));
    expect(answer).toContain(JSON.stringify(fusedLandCover));
  });

  test('trend series field', async () => {
    const answer = expectDegraded(await composeAnswer('trend', 'trend', [res('trend', { series: [1, 2, 3] })], []));
    expect(answer).toContain('3 observation(s)');
  });

  test('change legacy changePercentage field', async () => {
    const answer = expectDegraded(await composeAnswer('change', 'change', [res('change', { changePercentage: 12.4, mean_difference: 0.05, max_difference: 0.18 })], []));
    expect(answer).toContain('Change detected: 12.4%');
    expect(answer).toContain('mean difference 0.05');
    expect(answer).toContain('max difference 0.18');
  });

  test('area legacy areaKm2 field', async () => {
    const answer = expectDegraded(await composeAnswer('area', 'area', [res('area', { areaKm2: 10.2 })], []));
    expect(answer).toContain('Calculated area: 10.2 km²');
  });

  test('boundingBox field', async () => {
    const boundingBox = { x: 1, y: 2, w: 3, h: 4 };
    const answer = expectDegraded(await composeAnswer('ground', 'ground', [res('ground', { boundingBox })], []));
    expect(answer).toContain(JSON.stringify(boundingBox));
  });

  test('legacy result fields still work in multi-tool composition', async () => {
    const toolResults = [
      res('ndvi', { value: 0.62 }),
      res('area', { areaKm2: 10.2 }),
      res('change', { changePercentage: 8.4, mean_difference: 0.05 })
    ];
    const answer = expectDegraded(await composeAnswer('multi', 'mixed', toolResults, []));
    expect(answer).toContain('NDVI value: 0.62');
    expect(answer).toContain('Calculated area: 10.2 km²');
    expect(answer).toContain('Change detected: 8.4%');
  });
});
