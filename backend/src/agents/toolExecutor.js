import mlServiceClient from '../services/mlServiceClient.js';
import { makeTraceEntry } from '../utils/responseBuilder.js';
import ResultsCache from '../models/ResultsCache.js';
import { isMockTrendResult } from '../services/demoTrendService.js';
import { analyzeMultiTemporalSeries } from '../utils/multiTemporalAnalyzer.js';
import { interpretCandidateSemanticChange } from '../utils/semanticChangeInterpreter.js';
import crypto from 'crypto';

const MOCK_NO_FILE = 'mock-no-file';

function buildPayload(tool, tiles, parameters) {
  const opticalTile = tiles.find(t => t.modality === 'optical') || tiles[0];
  const sarTile = tiles.find(t => t.modality === 'sar');

  const payload = { ...parameters };
  const aoiSource = parameters.aoi || parameters.roi || parameters.region;
  if (aoiSource) {
    payload.aoi_geometry = aoiSource;
    // The AOI is bare GeoJSON, so the ML service assumes RFC 7946 (EPSG:4326)
    // unless the user states otherwise. Forward an explicit CRS when we have
    // one; never invent one.
    const aoiCrs = parameters.aoiCrs || parameters.aoi_crs || parameters.crs;
    if (aoiCrs) payload.aoi_crs = aoiCrs;
    payload.aoi_requested = true;
  } else {
    payload.aoi_requested = false;
  }

  switch (tool.name) {
    case 'vqa':
      payload.image_path = opticalTile?.filePath;
      payload.tile_id = String(opticalTile?._id);
      payload.question = parameters.question || '';
      break;
    case 'caption':
      payload.image_path = opticalTile?.filePath;
      payload.tile_id = String(opticalTile?._id);
      break;
    case 'ground':
      payload.image_path = opticalTile?.filePath;
      payload.tile_id = String(opticalTile?._id);
      payload.target = parameters.target || '';
      break;
    case 'change': {
      const sortedByDate = [...tiles].sort((a, b) => {
        if (a.captureDate && b.captureDate) return new Date(a.captureDate) - new Date(b.captureDate);
        return 0;
      });
      payload.image_t1_path = sortedByDate[0]?.filePath;
      payload.image_t2_path = sortedByDate[1]?.filePath;
      payload.tile_id_t1 = String(sortedByDate[0]?._id);
      payload.tile_id_t2 = String(sortedByDate[1]?._id);
      break;
    }
    case 'optical_sar':
      payload.optical_path = opticalTile?.filePath;
      payload.sar_path = sarTile?.filePath;
      payload.optical_tile_id = String(opticalTile?._id);
      payload.sar_tile_id = String(sarTile?._id);
      break;
    case 'ndvi':
    case 'ndwi':
      payload.image_path = opticalTile?.filePath;
      payload.tile_id = String(opticalTile?._id);
      break;
    case 'area':
      payload.image_path = opticalTile?.filePath;
      payload.tile_id = String(opticalTile?._id);
      payload.feature_type = parameters.featureType || '';
      break;
    case 'fetch-imagery':
      payload.bounding_box = parameters.bounding_box || parameters.boundingBox || parameters.region || {};
      if (parameters.startDate) payload.start_date = parameters.startDate;
      if (parameters.endDate) payload.end_date = parameters.endDate;
      break;
    case 'trend':
      payload.region = parameters.region || {};
      payload.metric = parameters.metric || 'ndvi';
      payload.start_date = parameters.startDate || '';
      payload.end_date = parameters.endDate || '';
      break;
    default:
      payload.image_path = opticalTile?.filePath;
      payload.tile_id = String(opticalTile?._id);
  }

  return payload;
}

/**
 * Resolve a fetch-imagery result into usable raster inputs.
 *
 * A raster is usable ONLY when the acquisition step actually produced a real,
 * downloaded file on disk: a non-empty string filePath that is not the
 * "mock-no-file" placeholder, and `downloaded !== false`. Mock acquisition
 * returns `filePath: null` / `downloaded: false`, which is deliberately NOT
 * treated as a real raster — downstream tools must not claim they analyzed
 * fetched imagery that does not exist.
 */
function extractFetchedRasters(depResult) {
  const images = depResult?.result?.images;
  if (!Array.isArray(images)) return { optical: null, sar: null, count: 0 };

  const usable = images.filter(img =>
    typeof img?.filePath === 'string' &&
    img.filePath.length > 0 &&
    img.filePath !== MOCK_NO_FILE &&
    img.downloaded !== false
  );

  return {
    optical: usable.find(img => img.modality === 'optical') || null,
    sar: usable.find(img => img.modality === 'sar') || null,
    count: usable.length
  };
}

function fetchedTileId(img, label) {
  return img ? `fetched-${img.product_id || img.captureDate || label}` : null;
}

/**
 * Contract-aware dependency output application.
 *
 * This is NOT a blind `previousResult` passthrough. Each tool advertises its
 * own input contract (raster file vs region/parameters), so dependency output
 * is only injected where the receiving tool's contract supports it:
 *
 * - fetch-imagery -> raster analysis tools (ndvi, ndwi, area, vqa, caption,
 *   ground, change, optical_sar): inject the fetched raster file path(s) when a
 *   real fetched raster exists.
 * - change -> area: attach the change result as explicit context (a compatible
 *   /area implementation may consume it); no raster handoff is fabricated.
 *
 * @param {object} tool        current ToolRegistry document
 * @param {string} depName     dependency tool name
 * @param {object} depResult   the SUCCESSFUL dependency result entry (ML-envelope)
 * @param {object} payload     the payload being built (already has original inputs)
 * @returns {{ payload: object, note: string|null }} the payload plus a truthful note
 */
function applyDependencyOutput(tool, depName, depResult, payload) {
  let note = null;

  if (depName === 'fetch-imagery') {
    const { optical, sar, count } = extractFetchedRasters(depResult);

    if (count === 0) {
      note = `fetch-imagery produced no usable raster; ${tool.name} analyzed original uploaded imagery (not fetched)`;
      return { payload, note };
    }

    const opticalPath = optical?.filePath;
    const sarPath = sar?.filePath;

    switch (tool.name) {
      case 'ndvi':
      case 'ndwi':
      case 'area':
      case 'vqa':
      case 'caption':
      case 'ground':
        if (opticalPath) {
          payload.image_path = opticalPath;
          payload.tile_id = fetchedTileId(optical, 'optical');
          note = `${tool.name} using fetched optical raster (${opticalPath})`;
        }
        break;
      case 'change':
        if (opticalPath && sarPath) {
          payload.image_t1_path = opticalPath;
          payload.image_t2_path = sarPath;
          payload.tile_id_t1 = fetchedTileId(optical, 't1');
          payload.tile_id_t2 = fetchedTileId(sar, 't2');
          note = 'change using fetched optical+SAR pair';
        }
        break;
      case 'optical_sar':
        if (opticalPath && sarPath) {
          payload.optical_path = opticalPath;
          payload.sar_path = sarPath;
          payload.optical_tile_id = fetchedTileId(optical, 'optical');
          payload.sar_tile_id = fetchedTileId(sar, 'sar');
          note = 'optical_sar using fetched optical+SAR pair';
        }
        break;
      default:
        // trend and friends take region/parameters, not rasters.
        note = `${tool.name}: fetch-imagery dependency resolved; no raster input supported by this tool`;
    }
  } else if (depName === 'change' && tool.name === 'area') {
    // /area expects a RASTER file; the change tool's summary output cannot be
    // turned into a raster here. We expose the change result as explicit
    // context (consumed only by a contract-aware ML service) and label the
    // feature type so an area computed from the change is never presented as an
    // unrelated measurement. When the change result already carries an
    // authoritative changed_area_km2, executeTools uses it directly instead of
    // calling /area (see the change/area branch in executeTools).
    payload.change_context = JSON.stringify({ result: depResult?.result || {}, summary: depResult?.result?.summary || null });
    if (!payload.feature_type) payload.feature_type = 'changed_area';
    note = 'area dependent on change; change context attached (used only where the /area contract supports it)';
  }

  return { payload, note };
}

/**
 * Describe what the ML service actually did with the AOI, using its own report.
 *
 * The backend must not assume the AOI was honored just because it was sent. We
 * relay the ML service's authoritative `aoi` report into the execution trace so
 * a scoped claim can always be checked against what was really applied.
 */
function aoiOutcomeNote(mlResult, payload) {
  if (!payload?.aoi_requested) {
    return 'no AOI requested; analysis covers the full scene (unscoped)';
  }
  const report = mlResult?.result?.aoi || mlResult?.metadata?.aoi;
  if (!report) {
    return 'AOI was requested but the ML service returned no AOI report; applied scope is unverified';
  }
  if (report.aoiApplied) {
    const scope = report.aoiScope || 'unknown scope';
    const masked = report.aoiMaskedPixels != null ? `, ${report.aoiMaskedPixels} pixel(s) masked` : '';
    return `AOI applied by ML service (${scope}${masked})`;
  }
  const reason = report.reason ? `: ${report.reason}` : '';
  return `AOI was NOT applied by ML service (${report.aoiStatus || 'unknown status'}${reason})`;
}

/**
 * Dependency-aware tool execution.
 *
 * The executor walks the structured plan (from M1) in order. For every step:
 *
 *   1. Resolve its `dependsOn` edges against already-completed results.
 *   2. If a required dependency did not succeed, SKIP the step (never fall back
 *      to unrelated original imagery), record the reason, and continue.
 *   3. Otherwise build the payload from the ORIGINAL tiles/parameters (the
 *      immutable execution context) and inject dependency outputs only where
 *      the receiving tool's contract supports them.
 *   4. Execute, validate, and store the result in the execution context for
 *      later dependent steps.
 *
 * The original `tiles` array and `parameters` object are never mutated.
 *
 * @param {object[]} tools       registered tool documents (execution order)
 * @param {object[]} tiles       original Tile documents (immutable inputs)
 * @param {object}   parameters  merged query parameters (immutable inputs)
 * @param {Array}    trace       execution trace to annotate
 * @param {object}   [plan]      structured plan from taskPlanner.buildPlan;
 *                               falls back to tools.plan when omitted
 * @returns {Promise<Array>} tool result entries (success/partial/failed/skipped)
 */
export async function executeTools(tools, tiles = [], parameters = {}, trace = [], plan = null) {
  const sourcePlan = plan || tools.plan || null;
  const stepMap = new Map(
    (sourcePlan?.steps || []).map(s => [s.tool, { dependsOn: s.dependsOn || [] }])
  );

  const results = [];
  const executionContext = {
    tiles,
    parameters,
    previousResults: new Map() // tool name -> successful result entry
  };

  for (const tool of tools) {
    const step = stepMap.get(tool.name) || { dependsOn: [] };
    const dependsOn = Array.from(new Set(step.dependsOn || []));

    // ---- 1. dependency resolution ------------------------------------------
    const unresolved = [];
    for (const dep of dependsOn) {
      const entry = results.find(r => r.tool === dep);
      if (!entry) {
        unresolved.push(`${dep}: not executed`);
      } else if (entry.status !== 'success') {
        unresolved.push(`${dep}: ${entry.status}${entry.error ? ` (${entry.error})` : ''}`);
      }
    }

    if (unresolved.length > 0) {
      // Required dependency failed -> do NOT execute; do NOT fall back to
      // unrelated original imagery. Preserve the reason deterministically.
      const reason = `Required dependency failed: ${unresolved.join('; ')}.`;
      trace.push(makeTraceEntry('tool_execution_skipped', `Tool "${tool.name}" skipped because ${reason}`));
      results.push({
        tool: tool.name,
        status: 'skipped',
        result: {},
        evidence: {},
        confidence: 0,
        error: `Skipped: ${reason}`
      });
      continue;
    }

    // ---- 2. build payload from the ORIGINAL inputs -------------------------
    let payload = buildPayload(tool, tiles, parameters);
    let dependencyNote = null;

    // ---- 3. inject dependency outputs where contracts support them ---------
    for (const dep of dependsOn) {
      const depEntry = executionContext.previousResults.get(dep);
      if (depEntry) {
        const applied = applyDependencyOutput(tool, dep, depEntry, payload);
        payload = applied.payload;
        dependencyNote = applied.note;
      }
    }

    // ---- 4. change -> area: authoritative changed-area value ----
    // When the change tool already computed changed_area_km2 for the changed
    // pixels, that value IS the changed area. Calling /area here would measure
    // the original imagery instead — a false claim. Derive the area result from
    // the change output instead of faking a raster handoff.
    if (tool.name === 'area' && dependsOn.includes('change')) {
      const changeEntry = executionContext.previousResults.get('change');
      const changedAreaKm2 = changeEntry?.result?.changed_area_km2;
      if (typeof changedAreaKm2 === 'number' && Number.isFinite(changedAreaKm2) && changedAreaKm2 > 0) {
        const derived = {
          tool: 'area',
          status: 'success',
          result: { area_km2: changedAreaKm2, area_m2: null, area_ha: null, source: 'change.changed_area_km2' },
          evidence: changeEntry.evidence || {},
          confidence: typeof changeEntry.confidence === 'number' ? Math.min(1, changeEntry.confidence) : 0.7,
          metadata: {
            mock: Boolean(changeEntry.metadata?.mock),
            derivedFrom: 'change.changed_area_km2',
            dependencyNote: 'area derived from the change tool\'s changed_area_km2 (no raster handed off)'
          }
        };
        trace.push(makeTraceEntry('tool_execution_derived',
          'Tool "area" derived from change.changed_area_km2 without an /area ML call (change already produced the changed area)'));
        trace.push(makeTraceEntry('aoi_application',
          `Tool "area": ${aoiOutcomeNote(changeEntry, payload)} (inherited from the change result; no separate /area measurement was performed)`));
        results.push(derived);
        executionContext.previousResults.set('area', derived);
        continue;
      }
    }

    // ---- 5. cache lookup (for trend) --------------------------------------
    // The AOI is part of a measurement's identity: a series computed inside a
    // scope must never be served to a request with a different (or no) scope.
    const aoiKey = payload.aoi_geometry
      ? JSON.stringify(payload.aoi_geometry)
      : null;
    if (tool.name === 'trend' && payload.metric && payload.region) {
      const metric = (payload.metric || 'ndvi').toLowerCase();
      const rKey = JSON.stringify({ type: payload.region.type, coordinates: payload.region.coordinates });
      const startDate = payload.start_date || payload.startDate;
      const endDate = payload.end_date || payload.endDate;

      const queryCond = {
        tool: 'trend',
        metric,
        expiresAt: { $gt: new Date() }
      };

      if (rKey) queryCond.regionKey = rKey;
      if (aoiKey) queryCond.aoiKey = aoiKey;
      else queryCond.aoiKey = null;
      if (startDate && endDate) {
        queryCond['dateRange.start'] = { $lte: new Date(startDate) };
        queryCond['dateRange.end'] = { $gte: new Date(endDate) };
      }

      const cached = await ResultsCache.findOne(queryCond);

      if (cached) {
        trace.push(makeTraceEntry('trend_cache_hit', `[trend] cache hit for ${metric}`));
        trace.push(makeTraceEntry('aoi_application', `Tool "trend": ${aoiOutcomeNote(cached, payload)}`));
        const analysis = analyzeMultiTemporalSeries(cached.result?.series || cached.result?.observations || [], { metric });
        const cachedEntry = {
          tool: 'trend',
          status: 'success',
          result: { ...cached.result, ...analysis },
          evidence: cached.evidence || {},
          confidence: cached.confidence || 0,
          metadata: { ...(cached.metadata || {}), cacheHit: true }
        };
        results.push(cachedEntry);
        executionContext.previousResults.set('trend', cachedEntry);
        continue;
      }
    }

    // ---- 6. execute --------------------------------------------------------
    trace.push(makeTraceEntry('tool_execution_start', `Calling tool "${tool.name}" at ${tool.endpoint}${dependencyNote ? ` — ${dependencyNote}` : ''}`));

    let mlResult;
    let mlError = null;
    try {
      mlResult = await mlServiceClient.callMlService(tool.endpoint, payload);
    } catch (err) {
      mlError = err;
    }

    if (mlError) {
      const reason = `ML service call threw an error for tool "${tool.name}": ${mlError.message}`;
      trace.push(makeTraceEntry('tool_execution_failed', reason));
      trace.push(makeTraceEntry('aoi_application', `Tool "${tool.name}": ${aoiOutcomeNote(null, payload)}`));
      results.push({ tool: tool.name, status: 'failed', result: {}, evidence: {}, error: reason, confidence: 0 });
      continue;
    }

    if (!mlResult || ['error', 'failed', 'failure'].includes(mlResult.status)) {
      // Normalize any ML failure signal (contract status "failed", legacy
      // "failure", or transport-level "error") into a single backend status.
      // Preserve the specific reason (result.error) so the final failure
      // response is honest, not "unknown error".
      const reason = mlResult?.error
        || mlResult?.result?.error
        || `ML service returned an error for tool "${tool.name}"`;
      trace.push(makeTraceEntry('tool_execution_failed', reason));
      trace.push(makeTraceEntry('aoi_application', `Tool "${tool.name}": ${aoiOutcomeNote(mlResult, payload)}`));
      results.push({ tool: tool.name, status: 'failed', result: {}, evidence: {}, error: reason, confidence: 0 });
    } else if (!mlResult.result && !mlResult.answer && !mlResult.caption && !mlResult.series) {
      const reason = `ML service returned an empty or malformed result for tool "${tool.name}"`;
      trace.push(makeTraceEntry('tool_execution_failed', reason));
      trace.push(makeTraceEntry('aoi_application', `Tool "${tool.name}": ${aoiOutcomeNote(mlResult, payload)}`));
      results.push({ tool: tool.name, status: 'failed', result: {}, evidence: {}, error: reason, confidence: 0 });
    } else {
      trace.push(makeTraceEntry('tool_execution_success', `Tool "${tool.name}" completed successfully${dependencyNote ? ` — ${dependencyNote}` : ''}`));
      trace.push(makeTraceEntry('aoi_application', `Tool "${tool.name}": ${aoiOutcomeNote(mlResult, payload)}`));
      let finalResult = mlResult.result;
      if (tool.name === 'trend' && mlResult.result) {
        const metric = (payload.metric || 'ndvi').toLowerCase();
        const analysis = analyzeMultiTemporalSeries(mlResult.result.series || mlResult.result.observations || [], { metric });
        finalResult = { ...mlResult.result, ...analysis };
      } else if (tool.name === 'change' && mlResult.result) {
        const ndviRes = executionContext.previousResults.get('ndvi')?.result;
        const ndwiRes = executionContext.previousResults.get('ndwi')?.result;
        const sarRes = executionContext.previousResults.get('optical_sar')?.result;
        const candidateInterpretation = interpretCandidateSemanticChange({
          changeResult: mlResult.result,
          supportingSignals: {
            ndviT1: ndviRes?.meanT1 ?? ndviRes?.t1,
            ndviT2: ndviRes?.meanT2 ?? ndviRes?.t2,
            ndwiT1: ndwiRes?.meanT1 ?? ndwiRes?.t1,
            ndwiT2: ndwiRes?.meanT2 ?? ndwiRes?.t2,
            sarRatio: sarRes?.backscatterRatio
          }
        });
        finalResult = { ...mlResult.result, candidateInterpretation };
      }
      const successEntry = { tool: tool.name, status: mlResult.status || 'success', ...mlResult, result: finalResult };
      if (dependencyNote) {
        successEntry.metadata = {
          ...(successEntry.metadata || {}),
          dependency: dependsOn.join(','),
          dependencyNote
        };
      }

      if (tool.name === 'trend' && ['success', 'partial'].includes(mlResult.status) && !isMockTrendResult(mlResult)) {
        const metric = (payload.metric || 'ndvi').toLowerCase();
        const paramHash = crypto.createHash('sha256').update(JSON.stringify({
          metric,
          region: payload.region,
          aoi: payload.aoi_geometry || null,
          aoiCrs: payload.aoi_crs || null,
          startDate: payload.start_date || payload.startDate,
          endDate: payload.end_date || payload.endDate
        })).digest('hex');
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);
        const sDate = payload.start_date || payload.startDate;
        const eDate = payload.end_date || payload.endDate;
        const rKey = payload.region ? JSON.stringify({ type: payload.region.type, coordinates: payload.region.coordinates }) : null;
        try {
          await ResultsCache.create({
            tool: 'trend',
            metric,
            region: payload.region,
            regionKey: rKey,
            aoiKey,
            dateRange: (sDate && eDate) ? { start: new Date(sDate), end: new Date(eDate) } : undefined,
            interval: payload.interval || 'monthly',
            parameters: { metric, region: payload.region, startDate: sDate, endDate: eDate, interval: payload.interval || 'monthly', hash: paramHash },
            result: mlResult.result || mlResult,
            evidence: mlResult.evidence || {},
            confidence: mlResult.confidence || 0,
            metadata: mlResult.metadata || {},
            expiresAt
          });
        } catch {
          // ignore duplicate key or indexing warning
        }
      }

      results.push(successEntry);
      executionContext.previousResults.set(tool.name, successEntry);
    }
  }

  return results;
}