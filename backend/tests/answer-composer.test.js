import { composeAnswer } from '../src/agents/answerComposer.js';

beforeEach(() => {
  process.env.LLM_API_KEY = 'mock-llm-key';
});

function res(tool, result, status = 'success') {
  return { tool, status, result, confidence: status === 'success' ? 1 : 0 };
}

describe('answerComposer fallback — multi-tool composition', () => {
  test('NDVI + NDWI both successful -> answer contains both', async () => {
    const toolResults = [
      res('ndvi', { mean: 0.5661764551843529 }),
      res('ndwi', { mean: -0.41346152756396204 })
    ];
    const answer = await composeAnswer('calculate NDVI and NDWI', 'multi-index-analysis', toolResults, []);
    expect(answer).toBe('NDVI value: 0.57. NDWI value: -0.41.');
  });

  test('NDVI + NDWI both successful via `value` legacy field -> answer contains both', async () => {
    const toolResults = [
      res('ndvi', { value: 0.62 }),
      res('ndwi', { value: 0.45 })
    ];
    const answer = await composeAnswer('calculate NDVI and NDWI', 'multi-index-analysis', toolResults, []);
    expect(answer).toBe('NDVI value: 0.62. NDWI value: 0.45.');
  });

  test('mixed composition: NDVI + AREA both successful', async () => {
    const toolResults = [
      res('ndvi', { mean: 0.64 }),
      res('area', { area_km2: 10.2 })
    ];
    const answer = await composeAnswer('calc ndvi and area', 'mixed', toolResults, []);
    expect(answer).toContain('NDVI value: 0.64.');
    expect(answer).toContain('Calculated area: 10.2 km².');
  });

  test('mixed composition: multiple tools with one failure -> successful result represented, failed not invented', async () => {
    const toolResults = [
      res('ndvi', { mean: 0.62 }, 'success'),
      res('ndwi', {}, 'failed')
    ];
    const answer = await composeAnswer('calculate NDVI and NDWI', 'multi-index-analysis', toolResults, []);
    expect(answer).toBe('NDVI value: 0.62.');
    expect(answer).not.toContain('NDWI value:');
    expect(answer).not.toContain('undefined');
    expect(answer).not.toContain('null');
  });
});

describe('answerComposer fallback — single-tool behavior preserved', () => {
  test('single NDVI (mean) -> existing output', async () => {
    const answer = await composeAnswer('calc ndvi', 'index-analysis', [res('ndvi', { mean: 0.5661764551843529 })], []);
    expect(answer).toBe('NDVI value: 0.57.');
  });

  test('single NDWI (mean) -> works', async () => {
    const answer = await composeAnswer('calc ndwi', 'index-analysis', [res('ndwi', { mean: 0.45 })], []);
    expect(answer).toBe('NDWI value: 0.45.');
  });

  test('all tools failed -> existing failure message remains', async () => {
    const toolResults = [
      res('ndvi', { error: 'no band' }, 'failed'),
      res('ndwi', {}, 'failed')
    ];
    const answer = await composeAnswer('calc', 'multi-index-analysis', toolResults, []);
    expect(answer).toBe('The analysis for your query could not be completed. The image processing service returned no results. Please check your uploaded images and try again.');
  });
});

describe('answerComposer fallback — field support preserved', () => {
  test('answer field', async () => {
    const answer = await composeAnswer('question', 'vqa', [res('vqa', { answer: 'Yes, water detected' })], []);
    expect(answer).toBe('Yes, water detected');
  });

  test('caption field', async () => {
    const answer = await composeAnswer('describe', 'caption', [res('caption', { caption: 'A flooded region' })], []);
    expect(answer).toBe('A flooded region');
  });

  test('summary field', async () => {
    const answer = await composeAnswer('analyze', 'analysis', [res('analysis', { summary: 'legacy summary text' })], []);
    expect(answer).toBe('legacy summary text');
  });

  test('fusedLandCover field', async () => {
    const fusedLandCover = { water: 0.6, vegetation: 0.4 };
    const answer = await composeAnswer('analyze', 'analysis', [res('analysis', { fusedLandCover })], []);
    expect(answer).toBe(`Fused analysis result: ${JSON.stringify(fusedLandCover)}`);
  });

  test('trend series field', async () => {
    const answer = await composeAnswer('trend', 'trend', [res('trend', { series: [1, 2, 3] })], []);
    expect(answer).toBe('Trend analysis returned 3 data point(s).');
  });

  test('change legacy changePercentage field', async () => {
    const answer = await composeAnswer('change', 'change', [res('change', { changePercentage: 12.4, mean_difference: 0.05, max_difference: 0.18 })], []);
    expect(answer).toBe('Change detected: 12.4%; mean difference 0.05; max difference 0.18.');
  });

  test('area legacy areaKm2 field', async () => {
    const answer = await composeAnswer('area', 'area', [res('area', { areaKm2: 10.2 })], []);
    expect(answer).toBe('Calculated area: 10.2 km².');
  });

  test('boundingBox field', async () => {
    const boundingBox = { x: 1, y: 2, w: 3, h: 4 };
    const answer = await composeAnswer('ground', 'ground', [res('ground', { boundingBox })], []);
    expect(answer).toBe(`Feature located at bounding box: ${JSON.stringify(boundingBox)}.`);
  });

  test('legacy result fields still work in multi-tool composition', async () => {
    const toolResults = [
      res('ndvi', { value: 0.62 }),
      res('area', { areaKm2: 10.2 }),
      res('change', { changePercentage: 8.4, mean_difference: 0.05 })
    ];
    const answer = await composeAnswer('multi', 'mixed', toolResults, []);
    expect(answer).toContain('NDVI value: 0.62.');
    expect(answer).toContain('Calculated area: 10.2 km².');
    expect(answer).toContain('Change detected: 8.4%');
  });
});