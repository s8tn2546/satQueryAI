import { classifyIntent } from '../src/agents/intentClassifier.js';

describe('Intent Classifier', () => {
  const mockTrace = [];

  beforeEach(() => {
    mockTrace.length = 0;
    process.env.LLM_API_KEY = 'mock-llm-key';
  });

  describe('Single image tasks', () => {
    test('classifies VQA query', async () => {
      const result = await classifyIntent(
        'What type of terrain is shown in this image?',
        [{ modality: 'optical' }],
        mockTrace
      );
      expect(result.taskType).toBe('VQA');
      expect(result.toolNames).toContain('vqa');
      expect(result.parameters.question).toBeTruthy();
    });

    test('classifies CAPTION query', async () => {
      const result = await classifyIntent(
        'Describe what is visible in this image',
        [{ modality: 'optical' }],
        mockTrace
      );
      expect(result.taskType).toBe('CAPTION');
      expect(result.toolNames).toContain('caption');
    });

    test('classifies GROUNDING query', async () => {
      const result = await classifyIntent(
        'Highlight the river in this image',
        [{ modality: 'optical' }],
        mockTrace
      );
      expect(result.taskType).toBe('GROUNDING');
      expect(result.toolNames).toContain('ground');
    });

    test('classifies NDVI query', async () => {
      const result = await classifyIntent(
        'Calculate the vegetation index',
        [{ modality: 'optical' }],
        mockTrace
      );
      expect(result.taskType).toBe('NDVI');
      expect(result.toolNames).toContain('ndvi');
    });

    test('classifies NDWI query', async () => {
      const result = await classifyIntent(
        'Calculate the water index',
        [{ modality: 'optical' }],
        mockTrace
      );
      expect(result.taskType).toBe('NDWI');
      expect(result.toolNames).toContain('ndwi');
    });

    test('classifies AREA query', async () => {
      const result = await classifyIntent(
        'How large is the water body?',
        [{ modality: 'optical' }],
        mockTrace
      );
      expect(result.taskType).toBe('AREA');
      expect(result.toolNames).toContain('area');
    });
  });

  describe('Multi-image tasks', () => {
    test('classifies CHANGE_ANALYSIS query', async () => {
      const result = await classifyIntent(
        'What has changed between these two images?',
        [{ modality: 'optical' }, { modality: 'optical' }],
        mockTrace
      );
      expect(result.taskType).toBe('CHANGE_ANALYSIS');
      expect(result.toolNames).toContain('change');
    });

    test('classifies OPTICAL_SAR fusion query', async () => {
      const result = await classifyIntent(
        'Fuse optical and SAR to identify built-up and water areas',
        [{ modality: 'optical' }, { modality: 'sar' }],
        mockTrace
      );
      expect(result.taskType).toBe('OPTICAL_SAR');
      expect(result.toolNames).toContain('optical_sar');
    });
  });

  describe('Historical/trend queries', () => {
    test('classifies TREND query', async () => {
      const result = await classifyIntent(
        'Show me the historical trend for vegetation in this region',
        [{ modality: 'optical' }],
        mockTrace
      );
      expect(result.taskType).toBe('TREND');
      expect(result.toolNames).toContain('trend');
    });
  });

  describe('Edge cases', () => {
    test('defaults to VQA for ambiguous queries', async () => {
      const result = await classifyIntent(
        'Tell me about this',
        [{ modality: 'optical' }],
        mockTrace
      );
      expect(result.taskType).toBe('VQA');
      expect(result.toolNames).toContain('vqa');
    });

    test('adds trace entries', async () => {
      await classifyIntent(
        'What is this?',
        [{ modality: 'optical' }],
        mockTrace
      );
      expect(mockTrace.length).toBeGreaterThan(0);
      expect(mockTrace[0].step).toBe('intent_classification_start');
    });
  });

  describe('Keyword detection', () => {
    test('detects change-related keywords', async () => {
      const queries = [
        'What has changed?',
        'Detect changes between images',
        'Has the built-up area increased?'
      ];
      
      for (const query of queries) {
        const result = await classifyIntent(query, [{ modality: 'optical' }, { modality: 'optical' }], []);
        expect(result.taskType).toBe('CHANGE_ANALYSIS');
      }
    });

    test('detects caption-related keywords', async () => {
      const queries = [
        'Describe this image',
        'What land-cover types are visible?',
        'Caption this satellite image'
      ];
      
      for (const query of queries) {
        const result = await classifyIntent(query, [{ modality: 'optical' }], []);
        expect(result.taskType).toBe('CAPTION');
      }
    });
  });
});
