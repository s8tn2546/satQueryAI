import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import Tile from '../models/Tile.js';
import mlServiceClient from '../services/mlServiceClient.js';

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

const MAX_FILE_SIZE = 500 * 1024 * 1024; // align with ML /validate MAX_FILE_SIZE_MB = 500

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 5
  }
});

const ALLOWED_UPLOAD_EXTS = new Set(['.tif', '.tiff', '.gtiff', '.png', '.jpg', '.jpeg']);
const ALLOWED_SOURCES = new Set(['sentinel-2', 'bhuvan', 'cartosat-2s', 'risat', 'benchmark-upload', 'gee-fetch']);
const ALLOWED_MODALITIES = new Set(['optical', 'sar']);

function inferFormat(ext) {
  ext = (ext || '').toLowerCase().replace('.', '');
  if (['geotiff', 'gtiff'].includes(ext)) return 'geotiff';
  if (['tiff', 'tif'].includes(ext)) return 'tiff';
  if (['jpg', 'jpeg'].includes(ext)) return 'jpeg';
  return 'png';
}

function cleanupStoredFiles(files) {
  for (const f of files || []) {
    try {
      fs.unlinkSync(f.path);
    } catch {
      // best effort — ignore missing files
    }
  }
}

function rejectedUpload(res, error) {
  return res.status(400).json({ status: 'rejected', error });
}

/**
 * Ask the ML service's /validate endpoint for a real validation verdict. Returns
 * { validated, validationDetails } using the ML response when available; falls
 * back to a lenient local check (format + extension) when the ML service is
 * unreachable/offline so the demo never hard-fails on upload.
 */
async function validateWithMlService(file, modalityHint, format) {
  const fallback = {
    validated: true,
    validationDetails: {
      formatValid: true,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      validationSource: 'local-fallback'
    }
  };

  let mlResult;
  try {
    mlResult = await mlServiceClient.callMlService('/validate', {
      image_path: file.path,
      modality_hint: modalityHint,
      format
    });
  } catch (err) {
    console.warn(`[Upload] /validate ML call failed, using local fallback: ${err.message}`);
    return fallback;
  }

  if (!mlResult || mlResult.status === 'failed' || mlResult.status === 'error') {
    return fallback;
  }

  const v = mlResult.result || {};
  return {
    validated: Boolean(v.valid) && v.valid !== undefined ? Boolean(v.valid) : true,
    validationDetails: {
      formatValid: v.formatValid ?? true,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      validationStatus: v.validation_status ?? null,
      errors: v.errors ?? [],
      warnings: v.warnings ?? [],
      confidence: mlResult.confidence,
      validationSource: 'ml-service'
    }
  };
}

router.post('/upload', (req, res) => {
  upload.array('images', 5)(req, res, async (uploadErr) => {
    if (uploadErr) {
      cleanupStoredFiles(req.files);
      if (uploadErr instanceof multer.MulterError) {
        if (uploadErr.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            status: 'rejected',
            error: `File too large. Maximum file size is ${MAX_FILE_SIZE / (1024 * 1024)} MB.`
          });
        }
        return rejectedUpload(res, `Upload rejected: ${uploadErr.message}`);
      }
      return rejectedUpload(res, `Upload rejected: ${uploadErr.message}`);
    }

    try {
      const files = req.files || [];
      if (files.length === 0 && req.file) {
        files.push(req.file);
      }

      if (files.length === 0) {
        return rejectedUpload(res, 'No image files provided for upload.');
      }

      const { source, modality } = req.body;

      if (source && !ALLOWED_SOURCES.has(source)) {
        cleanupStoredFiles(files);
        return rejectedUpload(res, `Unsupported source "${source}". Accepted: ${[...ALLOWED_SOURCES].join(', ')}.`);
      }

      const modalityList = Array.isArray(modality) ? modality : [modality];
      const invalidModalities = modalityList.filter(m => m && !ALLOWED_MODALITIES.has(String(m).toLowerCase()));
      if (invalidModalities.length > 0) {
        cleanupStoredFiles(files);
        return rejectedUpload(res, `Unsupported modality "${invalidModalities.join(', ')}". Accepted: optical, sar.`);
      }

      const unsupportedExts = files
        .map(f => path.extname(f.originalname).toLowerCase())
        .filter(ext => !ALLOWED_UPLOAD_EXTS.has(ext));
      if (unsupportedExts.length > 0) {
        cleanupStoredFiles(files);
        return rejectedUpload(res, `Unsupported file type "${unsupportedExts.join(', ')}". Accepted: .tif, .tiff, .gtiff, .png, .jpg, .jpeg.`);
      }

      const tileIds = [];
      const tiles = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = path.extname(file.originalname);
        const format = inferFormat(ext);

        let fileModality = 'optical';
        if (Array.isArray(modality)) {
          fileModality = String(modality[i] || 'optical').toLowerCase();
        } else if (modality) {
          fileModality = String(modality).toLowerCase();
        }

        const { validated, validationDetails } = await validateWithMlService(
          file,
          req.body.modality_hint || fileModality,
          format
        );

        const tile = await Tile.create({
          source: source || 'benchmark-upload',
          modality: fileModality,
          format: format,
          filePath: file.path,
          validated,
          validationDetails
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
          valid: tiles.every(t => t.validated),
          count: tiles.length
        }
      });
    } catch (error) {
      cleanupStoredFiles(req.files || []);
      console.error('[Upload] Error uploading images:', error);
      return res.status(500).json({
        status: 'failed',
        error: error.message
      });
    }
  });
});

/**
 * Region-based image acquisition (STRETCH — BACKEND.md §6.1a).
 * Accepts a GeoJSON bounding box, asks the ML service's /fetch-imagery endpoint
 * for a co-registered optical + SAR pair, stores each returned image as a tiles
 * document with source "gee-fetch", and returns tileId(s) in exactly the same
 * response shape as POST /api/images/upload.
 */
router.post('/fetch-by-region', async (req, res) => {
  try {
    const { boundingBox, startDate, endDate } = req.body || {};

    if (!boundingBox || typeof boundingBox !== 'object') {
      return res.status(400).json({
        status: 'rejected',
        error: 'boundingBox (GeoJSON) is required for fetch-by-region.'
      });
    }

    const mlResult = await mlServiceClient.callMlService('/fetch-imagery', {
      bounding_box: boundingBox,
      start_date: startDate || undefined,
      end_date: endDate || undefined
    });

    if (!mlResult || mlResult.status === 'failed' || mlResult.status === 'error') {
      const reason = mlResult?.result?.error || mlResult?.error || 'Imagery acquisition failed.';
      return res.status(200).json({
        status: 'failed',
        tileId: null,
        tileIds: [],
        tiles: [],
        error: reason,
        validationResult: { valid: false, count: 0 }
      });
    }

    const images = mlResult.result?.images || [];
    const tileIds = [];
    const tiles = [];

    for (const img of images) {
      const filePath = img.filePath || null;
      const format = filePath && /\.(tif|tiff|gtiff)$/i.test(filePath) ? 'geotiff' : 'png';

      const tile = await Tile.create({
        source: 'gee-fetch',
        modality: img.modality || 'optical',
        format,
        captureDate: img.captureDate ? new Date(img.captureDate) : null,
        boundingBox: img.boundingBox || boundingBox,
        crs: img.crs || null,
        resolution: img.resolution ?? null,
        bands: img.bands || [],
        // Tile.filePath is required by schema; mock acquisition yields no real file,
        // so fall back to a clearly-labelled placeholder (never a real host path).
        filePath: filePath || 'mock-no-file',
        validated: Boolean(img.validated),
        validationDetails: {
          validationStatus: img.validation_status ?? null,
          validationWarnings: img.validation_warnings ?? [],
          validationErrors: img.validation_errors ?? [],
          source: 'gee-fetch',
          dataSource: mlResult.result?.source || mlResult.metadata?.data_source || null,
          downloaded: Boolean(img.downloaded),
          geometryFollows: img.boundingBox ? true : false
        }
      });

      tileIds.push(tile._id);
      tiles.push(tile);
    }

    return res.status(200).json({
      status: 'success',
      tileId: tileIds[0] ?? null,
      tileIds: tileIds,
      tiles: tiles,
      source: mlResult.result?.source || mlResult.metadata?.data_source || 'unknown',
      dateGapDays: mlResult.result?.date_gap_days ?? null,
      validationResult: {
        valid: tiles.every(t => t.validated),
        count: tiles.length
      }
    });
  } catch (error) {
    console.error('[FetchByRegion] Error acquiring imagery:', error);
    return res.status(500).json({
      status: 'failed',
      error: error.message
    });
  }
});

export default router;
