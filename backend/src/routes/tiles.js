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
    storedFile: Boolean(storedFile),
    renderable: Boolean(storedFile) && BROWSER_RENDERABLE.has(tile.format)
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
 * returned with an explanatory error because browsers cannot render them.
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
    if (!BROWSER_RENDERABLE.has(tile.format)) {
      return res.status(415).json({
        status: 'failed',
        error: `Browsers cannot render ${tile.format.toUpperCase()} source imagery directly; a preview is not available.`,
        format: tile.format
      });
    }
    return res.sendFile(path.resolve(filePath));
  } catch (error) {
    console.error('[Tiles] Error serving tile image:', error);
    return res.status(500).json({ status: 'failed', error: 'An internal error occurred while serving the tile image.' });
  }
});

export default router;