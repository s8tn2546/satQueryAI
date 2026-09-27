/**
 * Trend result contract normaliser.
 *
 * The ML service and the backend multi-temporal analyzer each compute part of a
 * trend. Downstream consumers (composer, UI, cache) previously received whichever
 * shape happened to arrive, so `trendStats` / `observations` / `anomalies` were
 * simply absent on the direct route.
 *
 * This module produces one stable structure. It is strictly additive: every field
 * the ML service returned is preserved verbatim, so existing consumers and the
 * exact-match cache-parameter tests are unaffected.
 *
 * Nothing here invents a value. Fields that were not measured stay `null` or are
 * omitted rather than defaulted, and a region CRS is only surfaced when the
 * service actually reported one.
 */

import { analyzeMultiTemporalSeries } from './multiTemporalAnalyzer.js';

/**
 * Remove empty plain objects from a payload.
 *
 * MongoDB does not persist `{}`, so a result containing one comes back from the
 * cache with that key missing. That made a cache hit return a structurally
 * different payload than the cache miss that produced it. Empty *arrays* are
 * stored by MongoDB and are deliberately preserved, because `anomalies: []` and
 * `warnings: []` are meaningful ("checked, found none") and must not silently
 * become "absent".
 */
function pruneEmptyObjects(value) {
  if (Array.isArray(value)) {
    return value.map(pruneEmptyObjects);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object' && !Array.isArray(v)
        && !(v instanceof Date) && Object.keys(v).length === 0) {
        continue;
      }
      out[k] = pruneEmptyObjects(v);
    }
    return out;
  }
  return value;
}

/**
 * @param {object} mlResult - the ML /trend ToolOutput
 * @param {object} [options]
 * @param {string} [options.aoiName] - display label for the analysed scope
 * @returns {object} normalised trend result
 */
export function normalizeTrendResult(mlResult, options = {}) {
  const source = mlResult?.result && typeof mlResult.result === 'object'
    ? mlResult.result
    : (mlResult || {});

  const series = Array.isArray(source.series)
    ? source.series
    : (Array.isArray(mlResult?.series) ? mlResult.series : []);

  const metric = source.metric || mlResult?.evidence?.metric || null;
  const interval = source.interval || mlResult?.evidence?.interval || null;

  // Reuse the existing quality/anomaly/trend analyzer. It already encodes the
  // 0/1/2/3+ observation semantics, and it is the component that labels a
  // one- or two-point series as insufficient rather than inventing a direction.
  const analysis = analyzeMultiTemporalSeries(series, {
    metric: metric || 'ndvi',
    aoiName: options.aoiName || 'Selected AOI'
  });

  // The ML service's own stats are authoritative for the values it measured; the
  // analyzer's stats are a second, independent view. Both are exposed, and
  // neither overwrites the other.
  const mlTrend = source.trend && typeof source.trend === 'object' ? source.trend : null;

  const normalized = {
    // --- Identity and provenance -------------------------------------------
    metric,
    interval,
    source: source.source ?? mlResult?.metadata?.data_source ?? null,
    collection: source.collection ?? null,
    bandMapping: source.band_mapping ?? null,
    qualityMask: source.quality_mask ?? null,
    dataSource: mlResult?.metadata?.data_source ?? source.source ?? null,

    // --- Region -------------------------------------------------------------
    // `crs` is passed through only when the service reported it. The backend
    // never assumes a CRS for a region it was not told about.
    region: source.region ?? null,
    regionCrs: source.region?.crs ?? mlResult?.evidence?.region_crs ?? null,
    analyzedRegion: source.analyzedRegion ?? null,

    // --- Scope --------------------------------------------------------------
    aoiScope: source.aoiScope ?? mlResult?.evidence?.aoi_scope ?? null,
    aoiApplied: source.aoiScope?.aoiApplied ?? mlResult?.evidence?.aoi_applied ?? false,

    // --- Date range ---------------------------------------------------------
    dateRange: source.date_range ?? null,

    // --- Series and derived analysis ----------------------------------------
    // `series` is the ML service's normalised series, unchanged.
    series,
    // `observations` is the analyzer's quality-annotated view of the same points.
    observations: analysis.observations,
    qualityCounts: analysis.qualityCounts,
    // `trend` is the ML service's statistics; `trendStats` is the analyzer's.
    trend: mlTrend,
    trendStats: analysis.trendStats,
    anomalies: Array.isArray(source.anomalies) && source.anomalies.length
      ? source.anomalies
      : analysis.anomalies,

    // --- Honesty flags ------------------------------------------------------
    warnings: Array.isArray(source.warnings) ? source.warnings : [],
    // Mirrors the ML service's own `sufficient_for_trend`, so a consumer can
    // check the flag without re-deriving it.
    sufficientForTrend: mlTrend?.sufficient_for_trend ?? null,
    observationCount: mlTrend?.observation_count ?? analysis.trendStats?.validObservationsCount ?? null,
    missingCount: mlTrend?.missing_count ?? null,

    // --- Confidence ---------------------------------------------------------
    // The value the ML service actually computed. Not re-derived or blended.
    confidence: typeof mlResult?.confidence === 'number' ? mlResult.confidence : null
  };

  // Preserve any additional fields the ML service introduced so this normaliser
  // cannot silently drop contract additions.
  for (const [key, value] of Object.entries(source)) {
    if (!(key in normalized) && !Array.isArray(value) && typeof value !== 'object') {
      normalized[key] = value;
    }
  }

  // Cache-faithful form: the value returned to a client is byte-for-byte the
  // value that can be read back out of the cache.
  return pruneEmptyObjects(normalized);
}

export default normalizeTrendResult;
