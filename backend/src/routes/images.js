import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import Tile from '../models/Tile.js';

const router = express.Router();

const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({ storage });

router.post('/upload', upload.array('images', 5), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0 && req.file) {
      files.push(req.file);
    }

    if (files.length === 0) {
      return res.status(400).json({
        status: 'rejected',
        error: 'No image files provided for upload.'
      });
    }

    const { source, modality } = req.body;
    const tileIds = [];
    const tiles = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      let format = 'png';
      if (['geotiff', 'gtiff'].includes(ext)) format = 'geotiff';
      else if (['tiff', 'tif'].includes(ext)) format = 'tiff';
      else if (['jpg', 'jpeg'].includes(ext)) format = 'jpeg';
      else if (ext === 'png') format = 'png';

      // Determine default modality if array or string provided
      let fileModality = 'optical';
      if (Array.isArray(modality)) {
        fileModality = modality[i] || 'optical';
      } else if (modality) {
        fileModality = modality;
      }

      const tile = await Tile.create({
        source: source || 'benchmark-upload',
        modality: fileModality,
        format: format,
        filePath: file.path,
        validated: true,
        validationDetails: {
          formatValid: true,
          mimeType: file.mimetype,
          sizeBytes: file.size
        }
      });

      tileIds.push(tile._id);
      tiles.push(tile);
    }

    return res.status(200).json({
      status: 'success',
      tileId: tileIds[0],
      tileIds: tileIds,
      tiles: tiles,
      validationResult: {
        valid: true,
        count: tiles.length
      }
    });
  } catch (error) {
    console.error('[Upload] Error uploading images:', error);
    return res.status(500).json({
      status: 'failed',
      error: error.message
    });
  }
});

export default router;
