import express from 'express';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import Tile from '../models/Tile.js';
import { publicTile } from '../utils/publicTile.js';

const router = express.Router();

const CONTENT_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  geotiff: 'image/tiff',
  tiff: 'image/tiff'
};

const BROWSER_RENDERABLE = new Set(['png', 'jpeg']);

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