import ResultsCache from '../models/ResultsCache.js';
import mlServiceClient from './mlServiceClient.js';

const SUPPORTED_METRICS = new Set(['ndvi', 'ndwi']);
const SUPPORTED_INTERVALS = new Set(['monthly', 'yearly']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function regionKey(region) {
  return JSON.stringify({ type: region.type, coordinates: region.coordinates });
}

/**
 * A labeled mock/fallback ML result must never be treated as real data.
 * Shared guard: query route (caching decisions) and demo precompute rely on it.
 */
export function isMockTrendResult(mlResult) {
  return Boolean(
    mlResult?.metadata?.mock === true ||
    mlResult?.result?.source === 'mock' ||
    mlResult?.isMock === true
  );
}

/**
 * Resolve the configured demo-region trend parameters from the environment.
 *
 * This is read lazily on every call so tests and operators can set env vars
 * after module load. If the demo region is not fully configured, returns null
 * and all M5 fallback behavior stays inert (identical to pre-M5 behavior).
 *
 * Required for a valid config:
 *   DEMO_TREND_REGION  — GeoJSON Polygon/MultiPolygon (the chosen demo region)
 *   DEMO_TREND_START_DATE / DEMO_TREND_END_DATE — ISO YYYY-MM-DD
 * Optional:
 *   DEMO_TREND_METRIC   (default 'ndvi')
 *   DEMO_TREND_INTERVAL (default 'monthly')
 *   DEMO_TREND_TTL_DAYS (default 365 — long-lived so the demo never surprises)
 */
export function getDemoTrendConfig() {
  const raw = process.env.DEMO_TREND_REGION;
  if (!raw) return null;

  let region;
  try {
    region = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!region || !['Polygon', 'MultiPolygon'].includes(region.type) ||
      !Array.isArray(region.coordinates) || region.coordinates.length === 0) {
    return null;
  }

  const metric = String(process.env.DEMO_TREND_METRIC || 'ndvi').toLowerCase();
  const interval = String(process.env.DEMO_TREND_INTERVAL || 'monthly').toLowerCase();
  const startDate = process.env.DEMO_TREND_START_DATE;
  const endDate = process.env.DEMO_TREND_END_DATE;

  if (!SUPPORTED_METRICS.has(metric)) return null;
  if (!SUPPORTED_INTERVALS.has(interval)) return null;
  if (!startDate || !ISO_DATE_RE.test(startDate)) return null;
  if (!endDate || !ISO_DATE_RE.test(endDate)) return null;
  if (new Date(`${startDate}T00:00:00.000Z`) >= new Date(`${endDate}T00:00:00.000Z`)) return null;

  const ttlDays = Number.isFinite(Number(process.env.DEMO_TREND_TTL_DAYS)) && Number(process.env.DEMO_TREND_TTL_DAYS) > 0
    ? Number(process.env.DEMO_TREND_TTL_DAYS)
    : 365;

  return { region, metric, interval, startDate, endDate, ttlDays, regionKey: regionKey(region) };
}

export function isDemoRegion(region) {
  const cfg = getDemoTrendConfig();
  if (!cfg || !region || !region.type || !Array.isArray(region.coordinates)) return false;
  return regionKey(region) === cfg.regionKey;
}

/**
 * Find the latest valid precomputed demo-region trend entry for a request.
 * Only ever returns entries for the configured demo region (same regionKey),
 * never a mock-labeled cache entry, and never an expired one.
 */
export async function findDemoTrendFallback({ metric, interval, regionKey: requestedKey }) {
  const cfg = getDemoTrendConfig();
  if (!cfg) return null;
  if (!metric || !interval) return null;
  if (requestedKey !== cfg.regionKey) return null;

  const entry = await ResultsCache.findOne({
    tool: 'trend',
    metric,
    regionKey: cfg.regionKey,
    interval,
    expiresAt: { $gt: new Date() },
    'metadata.demoPrecomputed': true
  }).sort({ computedAt: -1 });

  if (!entry) return null;
  if (isMockTrendResult(entry)) return null;
  return entry;
}

/**
 * Precompute the configured demo region's trend result and cache it as the
 * offline/live-demo fallback (BACKEND.md §15.5).
 *
 * - Calls the real ML /trend path via the normal client.
 * - NEVER caches a labeled mock/fallback result.
 * - On ML/GEE failure, reports honestly and caches nothing.
 * - Uses the existing unique-index de-duplication (E11000 is success).
 */
export async function precomputeDemoTrend() {
  const cfg = getDemoTrendConfig();
  if (!cfg) {
    return {
      ok: false,
      reason: 'Demo trend not configured. Set DEMO_TREND_REGION (GeoJSON), DEMO_TREND_START_DATE and DEMO_TREND_END_DATE.'
    };
  }

  const mlResult = await mlServiceClient.callMlService('/trend', {
    region: cfg.region,
    metric: cfg.metric,
    start_date: cfg.startDate,
    end_date: cfg.endDate,
    interval: cfg.interval
  });

  if (!mlResult || !['success', 'partial'].includes(mlResult.status)) {
    const reason = mlResult?.result?.error || mlResult?.error || `ML /trend returned ${mlResult?.status || 'no status'}`;
    return { ok: false, reason: `Live ML /trend failed: ${reason} — nothing cached.` };
  }

  if (isMockTrendResult(mlResult)) {
    return {
      ok: false,
      reason: 'ML /trend returned a labeled mock/fallback result — refusing to cache it as real demo data.'
    };
  }

  const result = mlResult.result || {};
  const now = new Date();
  const expiresAt = new Date(now.getTime() + cfg.ttlDays * 24 * 60 * 60 * 1000);

  try {
    await ResultsCache.create({
      tool: 'trend',
      metric: cfg.metric,
      region: cfg.region,
      regionKey: cfg.regionKey,
      dateRange: { start: new Date(`${cfg.startDate}T00:00:00.000Z`), end: new Date(`${cfg.endDate}T00:00:00.000Z`) },
      series: (result.series || []).map(p => ({ date: p.date, value: p.value ?? null })),
      interval: cfg.interval,
      parameters: {
        region: cfg.region,
        metric: cfg.metric,
        startDate: cfg.startDate,
        endDate: cfg.endDate,
        interval: cfg.interval
      },
      result,
      evidence: mlResult.evidence || { region: cfg.region, notes: 'Precomputed demo-region trend' },
      confidence: mlResult.confidence || 0,
      metadata: { demoPrecomputed: true, data_source: 'demo-precompute' },
      expiresAt,
      computedAt: now
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return {
        ok: true,
        inserted: false,
        regionKey: cfg.regionKey,
        metric: cfg.metric,
        reason: 'Demo trend already cached (de-duplicated by unique index).'
      };
    }
    throw err;
  }

  return {
    ok: true,
    inserted: true,
    regionKey: cfg.regionKey,
    metric: cfg.metric,
    interval: cfg.interval,
    expiresAt: expiresAt.toISOString(),
    computedAt: now.toISOString()
  };
}

export default {
  getDemoTrendConfig,
  isDemoRegion,
  isMockTrendResult,
  findDemoTrendFallback,
  precomputeDemoTrend
};