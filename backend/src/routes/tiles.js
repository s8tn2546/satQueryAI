import express from 'express';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import Tile from '../models/Tile.js';

const router = express.Router();

const CONTENT_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  geotiff: 'image/tiff',
  tiff: 'image/tiff'
};

const BROWSER_RENDERABLE = new Set(['png', 'jpeg']);

/**
 * Public view of a tile for the Evidence UI. Never exposes the on-disk
 * filePath (server-internal); conveys only what the UI needs to render the
 * source imagery and label it correctly.
 */
function publicTile(tile) {
  const storedFile = typeof tile.filePath === 'string'
    && tile.filePath.length > 0
    && tile.filePath !== 'mock-no-file'
    && fs.existsSync(tile.filePath)
    && fs.statSync(tile.filePath).isFile();
  const previews = (tile.previews && typeof tile.previews === 'object') ? tile.previews : {};
  const previewPng = previews.png;
  const hasPreview = typeof previewPng === 'string'
    && previewPng.length > 0
    && fs.existsSync(previewPng)
    && fs.statSync(previewPng).isFile();
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
      png: hasPreview,
      channels: previews.channels || null,
      stretch: previews.stretch || null
    },
    metadata: tile.metadata || {},
    storedFile: Boolean(storedFile),
    hasPreview,
    renderable: (Boolean(storedFile) && BROWSER_RENDERABLE.has(tile.format)) || hasPreview
  };
}

/**
 * GET /api/tiles/:id
 * Tile metadata for evidence rendering (labels, modality, renderability).
 */
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ status: 'failed', error: 'Invalid tile id format.' });
    }
    const tile = await Tile.findById(req.params.id);
    if (!tile) {
      return res.status(404).json({ status: 'failed', error: 'Tile not found' });
    }
    return res.status(200).json(publicTile(tile));
  } catch (error) {
    console.error('[Tiles] Error fetching tile:', error);
    return res.status(500).json({ status: 'failed', error: 'An internal error occurred while fetching the tile.' });
  }
});

/**
 * GET /api/tiles/:id/image
 * Serves the persisted source image bytes for the Evidence view. Only
 * browser-renderable formats (PNG/JPEG) are served as pixels; TIFF rasters are
 * served through their derived preview when one exists, and returned with an
 * explanatory error when it does not.
 */
router.get('/:id/image', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ status: 'failed', error: 'Invalid tile id format.' });
    }
    const tile = await Tile.findById(req.params.id);
    if (!tile) {
      return res.status(404).json({ status: 'failed', error: 'Tile not found' });
    }
    const filePath = tile.filePath;
    if (!filePath || filePath === 'mock-no-file' || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return res.status(404).json({ status: 'failed', error: 'Source image file is not stored for this tile.' });
    }
    if (BROWSER_RENDERABLE.has(tile.format)) {
      return res.sendFile(path.resolve(filePath));
    }
    // TIFF/other: browsers cannot render the analysis raster directly; serve
    // the derived preview when the tile has one.
    const previewPng = tile.previews?.png;
    if (previewPng && fs.existsSync(previewPng) && fs.statSync(previewPng).isFile()) {
      return res.sendFile(path.resolve(previewPng));
    }
    return res.status(415).json({
      status: 'failed',
      error: `Browsers cannot render ${tile.format.toUpperCase()} source imagery directly and this tile has no derived preview.`,
      format: tile.format
    });
  } catch (error) {
    console.error('[Tiles] Error serving tile image:', error);
    return res.status(500).json({ status: 'failed', error: 'An internal error occurred while serving the tile image.' });
  }
});

/**
 * GET /api/tiles/:id/preview
 * Serves the derived RGB preview (e.g. for TIFF analysis rasters) directly.
 * 404 when this tile carries no preview.
 */
router.get('/:id/preview', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ status: 'failed', error: 'Invalid tile id format.' });
    }
    const tile = await Tile.findById(req.params.id);
    if (!tile) {
      return res.status(404).json({ status: 'failed', error: 'Tile not found' });
    }
    const previewPng = tile.previews?.png;
    if (!previewPng || !fs.existsSync(previewPng) || !fs.statSync(previewPng).isFile()) {
      return res.status(404).json({ status: 'failed', error: 'No preview is stored for this tile.' });
    }
    return res.sendFile(path.resolve(previewPng));
  } catch (error) {
    console.error('[Tiles] Error serving tile preview:', error);
    return res.status(500).json({ status: 'failed', error: 'An internal error occurred while serving the tile preview.' });
  }
});

export default router;