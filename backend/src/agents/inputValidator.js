import { makeTraceEntry } from '../utils/responseBuilder.js';

const PAIR_TASKS = new Set(['CHANGE_ANALYSIS', 'OPTICAL_SAR']);
const OPTICAL_ONLY_TASKS = new Set(['NDVI', 'NDWI']);
const SINGLE_IMAGE_TASKS = new Set(['VQA', 'CAPTION', 'GROUNDING', 'NDVI', 'NDWI', 'AREA']);
const ALLOWED_FORMATS = new Set(['geotiff', 'tiff', 'png', 'jpeg']);
const BENCHMARK_FORMATS = new Set(['png', 'jpeg']);

export function validateInputs(taskType, tiles, trace) {
  const warnings = [];

  if (PAIR_TASKS.has(taskType)) {
    if (tiles.length < 2) {
      const reason = `Task ${taskType} requires exactly 2 images; got ${tiles.length}.`;
      trace.push(makeTraceEntry('input_validation', `FAIL: ${reason}`));
      return { valid: false, reason };
    }

    if (taskType === 'OPTICAL_SAR') {
      const hasOptical = tiles.some(t => t.modality === 'optical');
      const hasSar = tiles.some(t => t.modality === 'sar');
      if (!hasOptical || !hasSar) {
        const reason = `Task OPTICAL_SAR requires one optical image and one SAR image; got modalities: [${tiles.map(t => t.modality).join(', ')}].`;
        trace.push(makeTraceEntry('input_validation', `FAIL: ${reason}`));
        return { valid: false, reason };
      }
    }

    for (const tile of tiles) {
      if (!ALLOWED_FORMATS.has(tile.format)) {
        const reason = `Unsupported image format "${tile.format}". Accepted: geotiff, tiff, png, jpeg.`;
        trace.push(makeTraceEntry('input_validation', `FAIL: ${reason}`));
        return { valid: false, reason };
      }
    }

    const hasGeoTiff = tiles.some(t => t.format === 'geotiff' || t.format === 'tiff');
    if (hasGeoTiff) {
      const missingBbox = tiles.filter(t => (t.format === 'geotiff' || t.format === 'tiff') && !t.boundingBox);
      if (missingBbox.length > 0) {
        warnings.push('GeoTIFF detected but bounding box metadata is absent; co-registration cannot be verified structurally.');
      }
    }
  } else if (SINGLE_IMAGE_TASKS.has(taskType)) {
    if (tiles.length === 0) {
      const reason = `Task ${taskType} requires at least 1 image; none provided.`;
      trace.push(makeTraceEntry('input_validation', `FAIL: ${reason}`));
      return { valid: false, reason };
    }

    if (OPTICAL_ONLY_TASKS.has(taskType)) {
      const nonOptical = tiles.filter(t => t.modality !== 'optical');
      if (nonOptical.length === tiles.length) {
        const reason = `Task ${taskType} requires an optical image; only SAR images were provided.`;
        trace.push(makeTraceEntry('input_validation', `FAIL: ${reason}`));
        return { valid: false, reason };
      }
    }

    for (const tile of tiles) {
      if (!ALLOWED_FORMATS.has(tile.format)) {
        const reason = `Unsupported image format "${tile.format}". Accepted: geotiff, tiff, png, jpeg.`;
        trace.push(makeTraceEntry('input_validation', `FAIL: ${reason}`));
        return { valid: false, reason };
      }
    }
  }

  const warningNote = warnings.length ? ` Warnings: ${warnings.join('; ')}` : '';
  trace.push(makeTraceEntry('input_validation', `PASS: Inputs valid for task ${taskType}.${warningNote}`));
  return { valid: true, warnings };
}
