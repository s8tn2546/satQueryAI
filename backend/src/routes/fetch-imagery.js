import express from 'express';
import Tile from '../models/Tile.js';
import mlServiceClient from '../services/mlServiceClient.js';

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { bounding_box, start_date, end_date, preferred_modality } = req.body;

    if (!bounding_box) {
      return res.status(400).json({
        status: 'failed',
        error: 'Missing required parameter: bounding_box'
      });
    }

    const mlResult = await mlServiceClient.callMlService('/fetch-imagery', {
      bounding_box,
      start_date,
      end_date,
      preferred_modality
    });

    if (mlResult.status !== 'success' || !mlResult.result?.images) {
      return res.status(200).json({
        status: mlResult.status || 'failed',
        error: mlResult.error || 'Failed to fetch imagery',
        images: []
      });
    }

    const tileIds = [];

    for (const image of mlResult.result.images) {
      const tile = await Tile.create({
        filename: image.filename || `fetched_${image.modality}_${Date.now()}.tif`,
        filePath: image.filePath,
        format: image.format || 'geotiff',
        modality: image.modality,
        source: 'gee-fetch',
        boundingBox: bounding_box,
        captureDate: image.date ? new Date(image.date) : null,
        metadata: {
          data_source: image.data_source || 'GEE',
          validated: image.validated || false,
          validation_status: image.validation_status,
          validation_warnings: image.validation_warnings || [],
          validation_errors: image.validation_errors || []
        }
      });
      tileIds.push(tile._id);
    }

    return res.status(200).json({
      status: 'success',
      images: tileIds.map(id => ({ tileId: id.toString() })),
      metadata: {
        date_gap_days: mlResult.result.date_gap_days,
        region: bounding_box
      }
    });
  } catch (error) {
    console.error('[Fetch Imagery] Error:', error);
    return res.status(500).json({
      status: 'failed',
      error: error.message,
      images: []
    });
  }
});

export default router;
