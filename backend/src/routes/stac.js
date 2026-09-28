import express from 'express';
import mongoose from 'mongoose';
import fs from 'fs';
import Tile from '../models/Tile.js';
import mlServiceClient from '../services/mlServiceClient.js';

const router = express.Router();

/**
 * Map a provider platform to the Tile.source vocabulary.
 * Returns null for an unrecognized platform so the caller rejects cleanly
 * instead of persisting an invented source.
 */
function deriveSource(platform) {
  const p = String(platform || '').toLowerCase();
  if (p.startsWith('sentinel')) return 'sentinel-2';
  if (p.startsWith('landsat-8')) return 'landsat-8';
  if (p.startsWith('landsat-9')) return 'landsat-9';
  return null;
}

/**
 * Normalize a WGS84 bounds dict into the canonical GeoJSON Polygon the Tile
 * schema expects. Returns null when the shape is unrecognized.
 */
function boundsToPolygon(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const isNum = n => typeof n === 'number' && Number.isFinite(n);
  const { west, south, east, north } = bounds;
  if (!isNum(west) || !isNum(south) || !isNum(east) || !isNum(north)) return null;
  return {
    type: 'Polygon',
    coordinates: [[
      [west, south], [east, south], [east, north], [west, north], [west, south]
    ]]
  };
}

/**
 * Public view of a STAC-ingested tile for the Evidence UI. Never exposes
 * server-internal paths except via existence booleans (filePath/analysisRaster
 * are server-internal).
 */
function publicTile(tile) {
  const fileExists = (p) => typeof p === 'string' && p.length > 0
    && p !== 'mock-no-file' && fs.existsSync(p) && fs.statSync(p).isFile();
  const previews = (tile.previews && typeof tile.previews === 'object') ? tile.previews : {};
  const previewPng = previews.png;
  return {
    _id: tile._id,
    source: tile.source,
    modality: tile.modality,
    format: tile.format,
    captureDate: tile.captureDate,
    crs: tile.crs,
    resolution: tile.resolution,
    bands: tile.bands || [],
    validated: tile.validated,
    boundingBox: tile.boundingBox || null,
    validationDetails: tile.validationDetails || {},
    provider: tile.provider || null,
    sceneId: tile.sceneId || null,
    collection: tile.collection || null,
    dedupeKey: tile.dedupeKey || null,
    previews: {
      png: Boolean(fileExists(previewPng)),
      channels: previews.channels || null,
      stretch: previews.stretch || null
    },
    metadata: tile.metadata || {},
    storedFile: Boolean(fileExists(tile.filePath)) || Boolean(fileExists(tile.analysisRaster)),
    hasPreview: Boolean(fileExists(previewPng)),
    renderable: Boolean(fileExists(previewPng))
  };
}

/**
 * POST /api/stac/search
 * Proxy a scene-search request to the ML service's /stac/search and return the
 * normalized catalog result (scene summaries, counts, mock labelling). No tile
 * is persisted: search is discovery only.
 */
router.post('/search', async (req, res) => {
  try {
    const { sensor, collection, dateRange, aoi, aoiCrs, cloudMax, limit } = req.body || {};

    if (!aoi || typeof aoi !== 'object') {
      return res.status(400).json({
        status: 'failed',
        error: 'aoi (GeoJSON Polygon/MultiPolygon) is required for /api/stac/search.'
      });
    }
    const dr = (dateRange && typeof dateRange === 'object') ? dateRange : {};
    if (!dr.start || !dr.end) {
      return res.status(400).json({
        status: 'failed',
        error: 'dateRange.start and dateRange.end (ISO YYYY-MM-DD) are required for /api/stac/search.'
      });
    }

    const mlResult = await mlServiceClient.callMlService('/stac/search', {
      sensor: sensor || undefined,
      collection: collection || undefined,
      dateRange: dr,
      aoi,
      aoiCrs: aoiCrs || undefined,
      cloudMax: cloudMax ?? undefined,
      limit: limit ?? undefined
    });

    if (!mlResult || mlResult.status === 'failed' || mlResult.status === 'error') {
      const reason = mlResult?.result?.error || mlResult?.error || 'Scene search failed.';
      return res.status(200).json({ status: 'failed', error: reason, scenes: [], count: 0 });
    }

    const r = mlResult.result || {};
    return res.status(200).json({
      status: 'success',
      source: r.source,
      provider: r.provider,
      collection: r.collection,
      collectionName: r.collectionName,
      resolution: r.resolution,
      query: r.query,
      scenes: r.scenes || [],
      count: r.count ?? (r.scenes || []).length,
      mock: Boolean(r.mock),
      reason: r.reason || null,
      warnings: r.warnings || [],
      confidence: mlResult.confidence,
      metadata: mlResult.metadata || {}
    });
  } catch (error) {
    console.error('[StacSearch] Error searching scenes:', error);
    return res.status(500).json({
      status: 'failed',
      error: error.message,
      scenes: [],
      count: 0
    });
  }
});

/**
 * POST /api/stac/ingest
 * Acquire the AOI of a specific scene through the ML service, then persist the
 * resulting analysis raster + preview as a Tile. Duplicate acquisitions (same
 * seed+AOI+bands+CRS) are detected via the deterministic dedupeKey and return
 * the existing tile instead of re-ingesting.
 */
router.post('/ingest', async (req, res) => {
  try {
    const { collection, sceneId, aoi, aoiCrs, bands, targetCrs, provider } = req.body || {};

    if (!collection || typeof collection !== 'string') {
      return res.status(400).json({
        status: 'failed',
        error: 'collection (STAC collection id) is required for /api/stac/ingest.'
      });
    }
    if (!sceneId || typeof sceneId !== 'string') {
      return res.status(400).json({
        status: 'failed',
        error: 'sceneId (provider scene id) is required for /api/stac/ingest.'
      });
    }
    if (!aoi || typeof aoi !== 'object') {
      return res.status(400).json({
        status: 'failed',
        error: 'aoi (GeoJSON Polygon/MultiPolygon) is required for /api/stac/ingest.'
      });
    }

    const mlResult = await mlServiceClient.callMlService('/stac/ingest', {
      provider: provider || undefined,
      collection,
      sceneId,
      aoi,
      aoiCrs: aoiCrs || undefined,
      bands: bands || undefined,
      targetCrs: targetCrs || undefined
    });

    if (!mlResult || mlResult.status === 'failed' || mlResult.status === 'error') {
      const reason = mlResult?.result?.error || mlResult?.error || 'Scene ingestion failed.';
      return res.status(200).json({
        status: 'failed',
        error: reason,
        tileId: null,
        tileIds: [],
        tiles: [],
        validationResult: { valid: false, count: 0 }
      });
    }

    const r = mlResult.result || {};
    const scene = r.scene || {};
    const analysis = r.analysis || {};
    const validation = r.validation || {};
    const preview = r.preview || {};

    const source = deriveSource(scene.platform);
    if (!source) {
      return res.status(422).json({
        status: 'failed',
        error: `Provider returned an unknown platform '${scene.platform || ''}'; no tile source could be derived and nothing was persisted.`
      });
    }

    const analysisPath = typeof r.analysisRaster === 'string' && r.analysisRaster.length > 0
      ? r.analysisRaster
      : 'mock-no-file';

    if (!r.dedupeKey) {
      return res.status(422).json({
        status: 'failed',
        error: 'ML service returned no dedupeKey; refusing to persist an untrackable tile.'
      });
    }

    // Deduplicate identical acquisitions before persisting anything.
    const existing = await Tile.findOne({ dedupeKey: r.dedupeKey });
    if (existing) {
      return res.status(200).json({
        status: 'success',
        duplicate: true,
        tileId: existing._id,
        tileIds: [existing._id],
        tiles: [publicTile(existing)],
        dedupeKey: r.dedupeKey,
        validationResult: { valid: Boolean(existing.validated), count: 1 }
      });
    }

    const resVal = (analysis.resolution && typeof analysis.resolution === 'object')
      ? analysis.resolution.x
      : null;

    const tile = await Tile.create({
      source,
      modality: 'optical',
      format: 'geotiff',
      captureDate: scene.datetime ? new Date(scene.datetime) : null,
      boundingBox: boundsToPolygon(analysis.wgs84Bounds) || null,
      crs: analysis.crs || null,
      resolution: Number.isFinite(resVal) ? Number(resVal) : null,
      bands: Array.isArray(analysis.bands) ? analysis.bands : [],
      filePath: analysisPath,
      validated: Boolean(validation.valid),
      validationDetails: {
        validationStatus: validation.status ?? null,
        integrity: validation.integrity ?? null,
        modality: validation.modality ?? null,
        errors: validation.errors ?? [],
        warnings: validation.warnings ?? [],
        datasetValidationSource: 'stac-ml-service'
      },
      isGeoreferenced: typeof validation.isGeoreferenced === 'boolean'
        ? validation.isGeoreferenced
        : null,
      integrity: validation.integrity ?? null,
      provider: r.provider || mlResult.metadata?.provider?.name || 'stac',
      sceneId: String(r.sceneId ?? sceneId),
      collection: r.collection || collection,
      analysisRaster: analysisPath,
      previews: preview.filePath ? {
        png: preview.filePath,
        channels: preview.channels || null,
        stretch: preview.stretch || null
      } : {},
      aoi: r.aoi?.geometry || null,
      aoiCrs: r.aoi?.crs || null,
      dedupeKey: r.dedupeKey,
      metadata: {
        source: r.source || null,
        provider: r.provider || null,
        collection: r.collection || null,
        sceneId: String(r.sceneId ?? sceneId),
        scene: scene.summary ? scene.summary() : scene,
        bandDescriptions: analysis.bandDescriptions || [],
        method: analysis.method || null,
        scope: analysis.scope || null,
        nativeBounds: analysis.nativeBounds || null,
        wgs84Bounds: analysis.wgs84Bounds || null,
        mock: Boolean(r.mock),
        reason: r.reason || null,
        warnings: r.warnings || [],
        confidence: mlResult.confidence ?? null,
        labels: mlResult.metadata?.provider || {}
      }
    });

    return res.status(200).json({
      status: 'success',
      duplicate: false,
      tileId: tile._id,
      tileIds: [tile._id],
      tiles: [publicTile(tile)],
      dedupeKey: r.dedupeKey,
      validationResult: {
        valid: Boolean(validation.valid),
        count: 1
      }
    });
  } catch (error) {
    console.error('[StacIngest] Error ingesting scene:', error);
    return res.status(500).json({
      status: 'failed',
      error: error.message,
      tileId: null,
      tileIds: [],
      tiles: []
    });
  }
});

export { publicTile };
export default router;