import { classifyIntent } from '../src/agents/intentClassifier.js';

describe('Intent Classifier - PS Representative Queries', () => {
  beforeEach(() => {
    process.env.LLM_API_KEY = 'mock-llm-key';
  });

  test('classifies "Describe the land-cover and major objects visible in this image." as CAPTION', async () => {
    const tiles = [{ modality: 'optical', format: 'geotiff' }];
    const trace = [];
    
    const result = await classifyIntent(
      'Describe the land-cover and major objects visible in this image.',
      tiles,
      trace
    );
    
    expect(result.taskType).toBe('CAPTION');
    expect(result.toolNames).toContain('caption');
  });

  test('classifies "Highlight the water body referred to in the query." as GROUNDING', async () => {
    const tiles = [{ modality: 'optical', format: 'geotiff' }];
    const trace = [];
    
    const result = await classifyIntent(
      'Highlight the water body referred to in the query.',
      tiles,
      trace
    );
    
    expect(result.taskType).toBe('GROUNDING');
    expect(result.toolNames).toContain('ground');
  });

  test('classifies "What changed between these two dates, and where did the change occur?" as CHANGE_ANALYSIS', async () => {
    const tiles = [
      { modality: 'optical', format: 'geotiff' },
      { modality: 'optical', format: 'geotiff' }
    ];
    const trace = [];
    
    const result = await classifyIntent(
      'What changed between these two dates, and where did the change occur?',
      tiles,
      trace
    );
    
    expect(result.taskType).toBe('CHANGE_ANALYSIS');
    expect(result.toolNames).toContain('change');
  });

  test('classifies "Use the optical and SAR images together to identify built-up and water-covered regions." as OPTICAL_SAR', async () => {
    const tiles = [
      { modality: 'optical', format: 'geotiff' },
      { modality: 'sar', format: 'geotiff' }
    ];
    const trace = [];
    
    const result = await classifyIntent(
      'Use the optical and SAR images together to identify built-up and water-covered regions.',
      tiles,
      trace
    );
    
    expect(result.taskType).toBe('OPTICAL_SAR');
    expect(result.toolNames).toContain('optical_sar');
  });

  test('classifies "Has the built-up area increased, decreased, or remained unchanged?" as CHANGE_ANALYSIS', async () => {
    const tiles = [
      { modality: 'optical', format: 'geotiff' },
      { modality: 'optical', format: 'geotiff' }
    ];
    const trace = [];
    
    const result = await classifyIntent(
      'Has the built-up area increased, decreased, or remained unchanged?',
      tiles,
      trace
    );
    
    expect(result.taskType).toBe('CHANGE_ANALYSIS');
    expect(result.toolNames).toContain('change');
  });
});
