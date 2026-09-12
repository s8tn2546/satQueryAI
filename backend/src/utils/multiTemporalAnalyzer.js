/**
 * Multi-temporal Monitoring Analyzer
 * 
 * Provides deterministic quality validation, trend statistics, anomaly detection,
 * and structured observation models for multi-temporal satellite imagery series.
 */

export function analyzeMultiTemporalSeries(rawSeries = [], options = {}) {
  const metric = (options.metric || 'NDVI').toUpperCase();
  const aoiName = options.aoiName || options.regionName || 'Selected AOI';

  const items = Array.isArray(rawSeries)
    ? rawSeries
    : (Array.isArray(rawSeries?.series) ? rawSeries.series : []);

  const observations = items.map((item, idx) => {
    const rawVal = item.value ?? item.val ?? item.metricValue;
    const dateStr = item.date || item.label || item.timestamp || `T${idx + 1}`;
    const validPct = typeof item.validPercent === 'number'
      ? item.validPercent
      : (typeof item.validPixelsRatio === 'number' ? item.validPixelsRatio * 100 : 100);
    const validPx = typeof item.validPixels === 'number' ? item.validPixels : null;
    const tileId = item.tileId || item.id || `TILE-${dateStr}`;
    const source = item.source || item.collection || 'Sentinel-2';
    const sensor = item.sensor || item.instrument || 'MSI';

    let quality = 'GOOD';
    let qualityReason = null;

    if (rawVal === null || rawVal === undefined || !Number.isFinite(rawVal)) {
      quality = 'EXCLUDED';
      qualityReason = 'Missing or invalid metric value';
    } else if (metric === 'NDVI' && (rawVal < -1.0 || rawVal > 1.0)) {
      quality = 'EXCLUDED';
      qualityReason = 'NDVI value out of valid physical range [-1.0, 1.0]';
    } else if (metric === 'NDWI' && (rawVal < -1.0 || rawVal > 1.0)) {
      quality = 'EXCLUDED';
      qualityReason = 'NDWI value out of valid physical range [-1.0, 1.0]';
    } else if (validPct < 50) {
      quality = 'EXCLUDED';
      qualityReason = `Valid pixel coverage below 50% threshold (${validPct.toFixed(1)}%)`;
    } else if (validPct < 80) {
      quality = 'WARNING';
      qualityReason = `Partial pixel coverage (${validPct.toFixed(1)}%)`;
    }

    return {
      date: dateStr,
      source,
      sensor,
      tileId,
      metric,
      value: quality === 'EXCLUDED' ? null : Number(rawVal),
      rawValue: rawVal,
      validPixels: validPx,
      validPercent: Number(validPct.toFixed(1)),
      quality,
      qualityReason,
      metadata: item.metadata || {}
    };
  });

  const qualityCounts = {
    good: observations.filter(o => o.quality === 'GOOD').length,
    warning: observations.filter(o => o.quality === 'WARNING').length,
    excluded: observations.filter(o => o.quality === 'EXCLUDED').length
  };

  const validObs = observations.filter(o => o.quality !== 'EXCLUDED' && typeof o.value === 'number');
  const validCount = validObs.length;

  let trendStats = {
    validObservationsCount: validCount,
    totalObservationsCount: observations.length,
    firstValue: null,
    lastValue: null,
    absoluteChange: null,
    relativeChange: null,
    slope: null,
    trendDirection: 'Insufficient data',
    trendStatus: 'Insufficient temporal observations.'
  };

  if (validCount >= 3) {
    const firstValue = validObs[0].value;
    const lastValue = validObs[validObs.length - 1].value;
    const absoluteChange = lastValue - firstValue;
    const relativeChange = firstValue !== 0
      ? (absoluteChange / Math.abs(firstValue)) * 100
      : null;

    // Linear regression slope over observation indices (0..n-1)
    const n = validCount;
    const meanIdx = (n - 1) / 2;
    const meanVal = validObs.reduce((acc, o) => acc + o.value, 0) / n;

    let num = 0;
    let den = 0;
    validObs.forEach((o, i) => {
      num += (i - meanIdx) * (o.value - meanVal);
      den += (i - meanIdx) * (i - meanIdx);
    });

    const slope = den !== 0 ? num / den : 0;
    let trendDirection = 'Stable';
    if (slope > 0.005) {
      trendDirection = 'Increasing';
    } else if (slope < -0.005) {
      trendDirection = 'Decreasing';
    }

    trendStats = {
      validObservationsCount: validCount,
      totalObservationsCount: observations.length,
      firstValue,
      lastValue,
      absoluteChange,
      relativeChange,
      slope,
      trendDirection,
      trendStatus: 'Valid trend calculated'
    };
  } else if (validCount === 2) {
    const firstValue = validObs[0].value;
    const lastValue = validObs[1].value;
    const absoluteChange = lastValue - firstValue;
    const relativeChange = firstValue !== 0
      ? (absoluteChange / Math.abs(firstValue)) * 100
      : null;

    trendStats = {
      validObservationsCount: 2,
      totalObservationsCount: observations.length,
      firstValue,
      lastValue,
      absoluteChange,
      relativeChange,
      slope: absoluteChange,
      trendDirection: 'Insufficient data',
      trendStatus: 'Temporal comparison available; insufficient observations for trend.'
    };
  } else if (validCount === 1) {
    trendStats = {
      validObservationsCount: 1,
      totalObservationsCount: observations.length,
      firstValue: validObs[0].value,
      lastValue: validObs[0].value,
      absoluteChange: null,
      relativeChange: null,
      slope: null,
      trendDirection: 'Insufficient data',
      trendStatus: 'Insufficient temporal observations.'
    };
  }

  // Anomalies / Events detection
  const anomalies = [];
  if (validCount >= 3) {
    const mean = validObs.reduce((acc, o) => acc + o.value, 0) / validCount;
    const variance = validObs.reduce((acc, o) => acc + Math.pow(o.value - mean, 2), 0) / validCount;
    const stdDev = Math.sqrt(variance);

    validObs.forEach((obs, idx) => {
      const dev = obs.value - mean;
      const prevObs = idx > 0 ? validObs[idx - 1] : null;
      const stepChange = prevObs ? Math.abs(obs.value - prevObs.value) : 0;

      if (Math.abs(dev) >= 1.5 * stdDev || stepChange >= 0.15) {
        const isDecrease = dev < 0 || (prevObs && obs.value < prevObs.value);
        const startDate = prevObs ? prevObs.date : obs.date;
        anomalies.push({
          id: `anomaly_${idx + 1}`,
          date: obs.date,
          observedValue: obs.value,
          baselineValue: Number(mean.toFixed(3)),
          deviation: Number(dev.toFixed(3)),
          type: isDecrease ? 'Anomalous decrease' : 'Anomalous increase',
          description: `Anomalous ${isDecrease ? 'decrease' : 'increase'} detected on ${obs.date} (observed: ${obs.value.toFixed(3)}, baseline mean: ${mean.toFixed(3)}).`,
          period: { start: startDate, end: obs.date }
        });
      }
    });
  }

  return {
    metric,
    aoiName,
    observations,
    qualityCounts,
    trendStats,
    anomalies
  };
}
