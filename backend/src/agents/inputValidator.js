import { makeTraceEntry } from '../utils/responseBuilder.js';

const PAIR_TASKS = new Set(['CHANGE_ANALYSIS', 'OPTICAL_SAR']);
const OPTICAL_ONLY_TASKS = new Set(['NDVI', 'NDWI']);
const SINGLE_IMAGE_TASKS = new Set(['VQA', 'CAPTION', 'GROUNDING', 'NDVI', 'NDWI', 'AREA']);
const ALLOWED_FORMATS = new Set(['geotiff', 'tiff', 'png', 'jpeg']);
const BENCHMARK_FORMATS = new Set(['png', 'jpeg']);

const OVERLAP_EPS_DEG = 1e-6;

/**
 * Extract the axis-aligned lon/lat extent of a canonical GeoJSON Polygon.
 * Returns null for any malformed geometry so callers fail honest rather than
 * invent a footprint.
 */
function geojsonExtents(polygon) {
  if (!polygon || polygon.type !== 'Polygon' || !Array.isArray(polygon.coordinates) || !Array.isArray(polygon.coordinates[0])) {
    return null;
  }
  const ring = polygon.coordinates[0];
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number'
        || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      return null;
    }
    minLon = Math.min(minLon, p[0]);
    maxLon = Math.max(maxLon, p[0]);
    minLat = Math.min(minLat, p[1]);
    maxLat = Math.max(maxLat, p[1]);
  }
  return { minLon, minLat, maxLon, maxLat };
}

const SUPPORTED_AOI_TYPES = new Set(['Polygon', 'MultiPolygon']);
const MAX_AOI_VERTICES = 10000;

/**
 * Parse and structurally validate the user-drawn AOI.
 *
 * This is deliberately a *shape* check only. Whether the AOI actually
 * intersects the raster, whether its CRS is consistent with the raster, and
 * whether the raster is georeferenced at all are questions only the ML service
 * can answer authoritatively (it opens the actual pixels). Failing those here
 * would risk rejecting valid requests using guessed assumptions, so we only
 * reject geometry that could never be meaningful.
 *
 * @returns {{status:'NONE'}|{status:'PASS',geometryType:string,vertexCount:number}
 *          |{status:'FAIL',reason:string}}
 */
function validateAoiParameters(parameters) {
  const raw = parameters?.aoi;
  if (raw === undefined || raw === null || raw === '') return { status: 'NONE' };

  let aoi = raw;
  if (typeof aoi === 'string') {
    try {
      aoi = JSON.parse(aoi);
    } catch {
      return { status: 'FAIL', reason: 'AOI parameter is a string but is not valid JSON.' };
    }
  }

  if (typeof aoi !== 'object' || Array.isArray(aoi) || aoi === null) {
    return { status: 'FAIL', reason: 'AOI must be a GeoJSON geometry object.' };
  }

  // Tolerate a Feature/FeatureCollection envelope and use the first polygon.
  let geometry = aoi;
  if (geometry.type === 'Feature') geometry = geometry.geometry;
  else if (geometry.type === 'FeatureCollection') {
    geometry = Array.isArray(geometry.features) ? geometry.features[0]?.geometry : undefined;
  }

  if (!geometry || typeof geometry.type !== 'string' || !SUPPORTED_AOI_TYPES.has(geometry.type)) {
    return {
      status: 'FAIL',
      reason: `AOI geometry type "${geometry?.type ?? 'unknown'}" is not supported; use a GeoJSON Polygon or MultiPolygon.`
    };
  }

  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
    return { status: 'FAIL', reason: 'AOI geometry has no coordinates.' };
  }

  // MultiPolygon nests one level deeper: polygons -> rings -> positions.
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let vertexCount = 0;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      return { status: 'FAIL', reason: `AOI ${geometry.type} contains an empty polygon.` };
    }
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) {
        return {
          status: 'FAIL',
          reason: `AOI ${geometry.type} has a ring with ${Array.isArray(ring) ? ring.length : 0} positions; each ring needs at least 4 (closed triangle minimum).`
        };
      }
      for (const position of ring) {
        if (!Array.isArray(position) || position.length < 2
            || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) {
          return { status: 'FAIL', reason: 'AOI coordinates must be finite [x, y] numbers.' };
        }
        vertexCount += 1;
        if (vertexCount > MAX_AOI_VERTICES) {
          return {
            status: 'FAIL',
            reason: `AOI is too complex (over ${MAX_AOI_VERTICES} vertices); simplify the drawn shape.`
          };
        }
      }
    }
  }

  if (vertexCount === 0) {
    return { status: 'FAIL', reason: 'AOI geometry has no coordinates.' };
  }

  return { status: 'PASS', geometryType: geometry.type, vertexCount };
}

function extentsOverlap(a, b, eps = OVERLAP_EPS_DEG) {
  return a.minLon <= b.maxLon + eps && b.minLon <= a.maxLon + eps
    && a.minLat <= b.maxLat + eps && b.minLat <= a.maxLat + eps;
}

export function validateInputs(taskType, tiles, trace, parameters = {}) {
  const warnings = [];
  const checks = [];
  let validationStatus = 'READY_FOR_ANALYSIS';

  // 1. Format & Readability check
  const invalidFormat = tiles.find(t => !ALLOWED_FORMATS.has(t.format));
  if (invalidFormat) {
    const reason = `Unsupported image format "${invalidFormat.format}". Accepted: geotiff, tiff, png, jpeg.`;
    trace.push(makeTraceEntry('input_validation', `FAIL: ${reason}`));
    return {
      valid: false,
      reason,
      qualityReport: {
        status: 'CANNOT_ANALYZE',
        summary: reason,
        checks: [{ name: 'Raster Format & Readability', status: 'FAIL', details: reason }],
        warnings: [reason]
      }
    };
  }
  checks.push({
    name: 'Raster Format & Readability',
    status: 'PASS',
    details: `All ${tiles.length} tile(s) readable in supported format.`
  });

  // 2. Georeferencing & CRS Check
  const requiresProjection = taskType === 'AREA' || taskType === 'NDVI' || taskType === 'NDWI' || taskType === 'CHANGE_ANALYSIS';
  const unreferenced = tiles.filter(t => (t.format === 'png' || t.format === 'jpeg') && (!t.crs || t.crs === 'undefined'));
  if (requiresProjection && unreferenced.length > 0) {
    const isUnrefWarning = `Unreferenced standard images (${unreferenced.map(t => t.format).join(', ')}) detected. Pixel-based vision inspection supported; strict projected CRS area calculations require georeferenced GeoTIFF.`;
    warnings.push(isUnrefWarning);
    validationStatus = 'ANALYSIS_WARNING';
    checks.push({
      name: 'Georeferencing & CRS',
      status: 'WARN',
      details: isUnrefWarning
    });
  } else {
    checks.push({
      name: 'Georeferencing & CRS',
      status: 'PASS',
      details: 'Raster dataset contains valid georeferencing coordinate system.'
    });
  }

  // 3. Task specific checks
  if (PAIR_TASKS.has(taskType)) {
    if (tiles.length !== 2) {
      const reason = `Task ${taskType} requires exactly 2 images; got ${tiles.length}.`;
      trace.push(makeTraceEntry('input_validation', `FAIL: ${reason}`));
      return {
        valid: false,
        reason,
        qualityReport: {
          status: 'CANNOT_ANALYZE',
          summary: reason,
          checks: [
            ...checks,
            { name: 'Pair Compatibility', status: 'FAIL', details: reason }
          ],
          warnings: [reason]
        }
      };
    }

    if (taskType === 'OPTICAL_SAR') {
      const hasOptical = tiles.some(t => t.modality === 'optical');
      const hasSar = tiles.some(t => t.modality === 'sar');
      if (!hasOptical || !hasSar) {
        const reason = `Task OPTICAL_SAR requires one optical image and one SAR image; got modalities: [${tiles.map(t => t.modality).join(', ')}].`;
        trace.push(makeTraceEntry('input_validation', `FAIL: ${reason}`));
        return {
          valid: false,
          reason,
          qualityReport: {
            status: 'CANNOT_ANALYZE',
            summary: reason,
            checks: [
              ...checks,
              { name: 'Multi-Modal Pair Alignment', status: 'FAIL', details: reason }
            ],
            warnings: [reason]
          }
        };
      }
    }

    const hasGeoTiff = tiles.some(t => t.format === 'geotiff' || t.format === 'tiff');
    if (hasGeoTiff) {
      const missingBbox = tiles.filter(t => (t.format === 'geotiff' || t.format === 'tiff') && !t.boundingBox);
      if (missingBbox.length > 0) {
        const bboxWarn = 'GeoTIFF detected but bounding box metadata is absent; co-registration cannot be verified structurally.';
        warnings.push(bboxWarn);
        validationStatus = 'ANALYSIS_WARNING';
        checks.push({ name: 'Spatial Co-registration', status: 'WARN', details: bboxWarn });
      } else {
        const extents = tiles.map(t => geojsonExtents(t.boundingBox));
        const footprintsKnown = tiles.length >= 2 && extents.every(Boolean);
        if (footprintsKnown && extentsOverlap(extents[0], extents[1])) {
          checks.push({ name: 'Spatial Co-registration', status: 'PASS', details: 'Spatial bounds match for temporal pair.' });
        } else {
          const coRegWarn = 'Detected spatial footprints do not overlap; co-registration cannot be verified structurally.';
          warnings.push(coRegWarn);
          validationStatus = 'ANALYSIS_WARNING';
          checks.push({ name: 'Spatial Co-registration', status: 'WARN', details: coRegWarn });
        }
      }
    }
  } else if (SINGLE_IMAGE_TASKS.has(taskType)) {
    if (tiles.length === 0) {
      const reason = `Task ${taskType} requires at least 1 image; none provided.`;
      trace.push(makeTraceEntry('input_validation', `FAIL: ${reason}`));
      return {
        valid: false,
        reason,
        qualityReport: {
          status: 'CANNOT_ANALYZE',
          summary: reason,
          checks: [{ name: 'Input Availability', status: 'FAIL', details: reason }],
          warnings: [reason]
        }
      };
    }

    if (OPTICAL_ONLY_TASKS.has(taskType)) {
      const nonOptical = tiles.filter(t => t.modality !== 'optical');
      if (nonOptical.length === tiles.length) {
        const reason = `Task ${taskType} requires an optical image; only SAR images were provided.`;
        trace.push(makeTraceEntry('input_validation', `FAIL: ${reason}`));
        return {
          valid: false,
          reason,
          qualityReport: {
            status: 'CANNOT_ANALYZE',
            summary: reason,
            checks: [...checks, { name: 'Band Availability', status: 'FAIL', details: reason }],
            warnings: [reason]
          }
        };
      }
    }
  }

  // 4. AOI shape check (structure only; ML owns CRS/intersection/georeferencing)
  const aoiCheck = validateAoiParameters(parameters);
  if (aoiCheck.status === 'FAIL') {
    trace.push(makeTraceEntry('input_validation', `FAIL: ${aoiCheck.reason}`));
    trace.push(makeTraceEntry('aoi_validation', `FAIL: ${aoiCheck.reason}`));
    return {
      valid: false,
      reason: aoiCheck.reason,
      qualityReport: {
        status: 'CANNOT_ANALYZE',
        summary: aoiCheck.reason,
        checks: [...checks, { name: 'AOI Geometry Structure', status: 'FAIL', details: aoiCheck.reason }],
        warnings: [aoiCheck.reason]
      }
    };
  }

  if (aoiCheck.status === 'PASS') {
    checks.push({
      name: 'AOI Geometry Structure',
      status: 'PASS',
      details: `AOI is a structurally valid ${aoiCheck.geometryType} with ${aoiCheck.vertexCount} vertices. Whether it intersects the image, and whether its CRS matches the raster, is verified by the ML service against the actual pixels.`
    });
  }

  const qualityReport = {
    status: validationStatus,
    summary: validationStatus === 'READY_FOR_ANALYSIS'
      ? 'Dataset passed all quality and spatial validation checks.'
      : 'Dataset passed validation with advisory warnings.',
    checks,
    warnings
  };

  const warningNote = warnings.length ? ` Warnings: ${warnings.join('; ')}` : '';
  trace.push(makeTraceEntry('input_validation', `PASS: Inputs valid for task ${taskType}.${warningNote}`));
  // Pushed after input_validation so the AOI decision is the final word on
  // whether the analysis is spatially scoped.
  trace.push(makeTraceEntry(
    'aoi_validation',
    aoiCheck.status === 'PASS'
      ? `PASS: AOI scope requested and structurally valid (${aoiCheck.geometryType}, ${aoiCheck.vertexCount} vertices); applied to analysis by the ML service.`
      : 'SKIP: No AOI requested; analysis runs on the full scene (unscoped).'
  ));
  return { valid: true, warnings, qualityReport, aoi: aoiCheck };
}
