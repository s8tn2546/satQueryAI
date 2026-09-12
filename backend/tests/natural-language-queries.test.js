import { classifyIntent } from '../src/agents/intentClassifier.js';

describe('Natural Language Map Queries (Feature 9)', () => {
  test('classifies "Show vegetation decline in this field" as CHANGE_ANALYSIS / NDVI', async () => {
    const trace = [];
    const tiles = [{ _id: 't1', modality: 'optical' }, { _id: 't2', modality: 'optical' }];
    const res = await classifyIntent('Show vegetation decline in this field.', tiles, trace);
    expect(['CHANGE_ANALYSIS', 'NDVI']).toContain(res.taskType);
    expect(res.toolNames).toContain('change');
  });

  test('classifies "Show areas where water increased" as CHANGE_ANALYSIS / NDWI', async () => {
    const trace = [];
    const tiles = [{ _id: 't1', modality: 'optical' }, { _id: 't2', modality: 'optical' }];
    const res = await classifyIntent('Show areas where water increased.', tiles, trace);
    expect(['CHANGE_ANALYSIS', 'NDWI']).toContain(res.taskType);
  });

  test('classifies "Monitor vegetation over the last year" as TREND with metric NDVI', async () => {
    const trace = [];
    const tiles = [{ _id: 't1', modality: 'optical' }];
    const res = await classifyIntent('Monitor vegetation over the last year.', tiles, trace);
    expect(res.taskType).toBe('TREND');
    expect(res.toolNames).toContain('trend');
  });

  test('classifies "Investigate the largest change" as CHANGE_ANALYSIS', async () => {
    const trace = [];
    const tiles = [{ _id: 't1', modality: 'optical' }, { _id: 't2', modality: 'optical' }];
    const res = await classifyIntent('Investigate the largest change.', tiles, trace);
    expect(res.taskType).toBe('CHANGE_ANALYSIS');
    expect(res.toolNames).toContain('change');
  });
});
