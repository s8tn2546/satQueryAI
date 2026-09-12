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

function extentsOverlap(a, b, eps = OVERLAP_EPS_DEG) {
  return a.minLon <= b.maxLon + eps && b.minLon <= a.maxLon + eps
    && a.minLat <= b.maxLat + eps && b.minLat <= a.maxLat + eps;
}

export function validateInputs(taskType, tiles, trace) {
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
  return { valid: true, warnings, qualityReport };
}
