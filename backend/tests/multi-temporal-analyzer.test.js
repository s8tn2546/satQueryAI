import { analyzeMultiTemporalSeries } from '../src/utils/multiTemporalAnalyzer.js';

describe('Multi-temporal Monitoring Analyzer', () => {
  test('returns insufficient status when 0 or 1 observations', () => {
    const res0 = analyzeMultiTemporalSeries([], { metric: 'NDVI' });
    expect(res0.trendStats.trendStatus).toBe('Insufficient temporal observations.');
    expect(res0.trendStats.trendDirection).toBe('Insufficient data');
    expect(res0.observations).toHaveLength(0);

    const res1 = analyzeMultiTemporalSeries([{ date: '2024-01-01', value: 0.6 }], { metric: 'NDVI' });
    expect(res1.trendStats.trendStatus).toBe('Insufficient temporal observations.');
    expect(res1.trendStats.trendDirection).toBe('Insufficient data');
    expect(res1.observations).toHaveLength(1);
  });

  test('returns comparison available status when exactly 2 observations', () => {
    const raw = [
      { date: '2024-01-01', value: 0.6, validPercent: 95 },
      { date: '2024-02-01', value: 0.4, validPercent: 90 }
    ];
    const res = analyzeMultiTemporalSeries(raw, { metric: 'NDVI' });
    expect(res.trendStats.trendStatus).toBe('Temporal comparison available; insufficient observations for trend.');
    expect(res.trendStats.trendDirection).toBe('Insufficient data');
    expect(res.trendStats.validObservationsCount).toBe(2);
    expect(res.trendStats.absoluteChange).toBeCloseTo(-0.2);
  });

  test('calculates trend statistics and direction when 3+ valid observations', () => {
    const raw = [
      { date: '2024-01-01', value: 0.20, validPercent: 95, source: 'Sentinel-2' },
      { date: '2024-02-01', value: 0.35, validPercent: 92, source: 'Sentinel-2' },
      { date: '2024-03-01', value: 0.50, validPercent: 98, source: 'Sentinel-2' },
      { date: '2024-04-01', value: 0.65, validPercent: 99, source: 'Sentinel-2' }
    ];
    const res = analyzeMultiTemporalSeries(raw, { metric: 'NDVI' });
    expect(res.trendStats.trendStatus).toBe('Valid trend calculated');
    expect(res.trendStats.trendDirection).toBe('Increasing');
    expect(res.trendStats.validObservationsCount).toBe(4);
    expect(res.trendStats.firstValue).toBe(0.20);
    expect(res.trendStats.lastValue).toBe(0.65);
    expect(res.trendStats.absoluteChange).toBeCloseTo(0.45);
    expect(res.trendStats.slope).toBeGreaterThan(0);
  });

  test('correctly labels quality status GOOD, WARNING, EXCLUDED', () => {
    const raw = [
      { date: '2024-01-01', value: 0.5, validPercent: 95 },
      { date: '2024-02-01', value: 0.4, validPercent: 65 }, // warning
      { date: '2024-03-01', value: 1.5, validPercent: 90 }, // excluded (out of range)
      { date: '2024-04-01', value: 0.3, validPercent: 30 }  // excluded (low valid pixels)
    ];
    const res = analyzeMultiTemporalSeries(raw, { metric: 'NDVI' });
    expect(res.observations[0].quality).toBe('GOOD');
    expect(res.observations[1].quality).toBe('WARNING');
    expect(res.observations[2].quality).toBe('EXCLUDED');
    expect(res.observations[3].quality).toBe('EXCLUDED');
    expect(res.qualityCounts.good).toBe(1);
    expect(res.qualityCounts.warning).toBe(1);
    expect(res.qualityCounts.excluded).toBe(2);
    expect(res.trendStats.validObservationsCount).toBe(2);
    expect(res.trendStats.trendStatus).toBe('Temporal comparison available; insufficient observations for trend.');
  });

  test('detects anomalous change event without ungrounded semantic claim', () => {
    const raw = [
      { date: '2024-01-01', value: 0.60, validPercent: 95 },
      { date: '2024-02-01', value: 0.62, validPercent: 95 },
      { date: '2024-03-01', value: 0.15, validPercent: 95 }, // sudden anomaly
      { date: '2024-04-01', value: 0.58, validPercent: 95 },
      { date: '2024-05-01', value: 0.61, validPercent: 95 }
    ];
    const res = analyzeMultiTemporalSeries(raw, { metric: 'NDVI' });
    expect(res.anomalies.length).toBeGreaterThan(0);
    const drop = res.anomalies[0];
    expect(drop.type).toBe('Anomalous decrease');
    expect(drop.date).toBe('2024-03-01');
    expect(drop.period.start).toBe('2024-02-01');
    expect(drop.period.end).toBe('2024-03-01');
  });
});
