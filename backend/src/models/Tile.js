import mongoose from 'mongoose';

const geoJsonPolygonSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['Polygon'],
    required: true
  },
  coordinates: {
    type: [[[Number]]],
    required: true
  }
}, { _id: false });

const tileSchema = new mongoose.Schema({
  source: {
    type: String,
    enum: ['sentinel-2', 'bhuvan', 'cartosat-2s', 'risat', 'benchmark-upload', 'gee-fetch'],
    required: true
  },
  modality: {
    type: String,
    enum: ['optical', 'sar'],
    required: true
  },
  format: {
    type: String,
    enum: ['geotiff', 'tiff', 'png', 'jpeg'],
    required: true
  },
  captureDate: { type: Date, default: null },
  boundingBox: {
    type: geoJsonPolygonSchema,
    default: null
  },
  crs: { type: String, default: null },
  resolution: { type: Number, default: null },
  bands: { type: [String], default: [] },
  filePath: { type: String, required: true },
  validated: { type: Boolean, default: false },
  validationDetails: { type: Object, default: {} }
}, { timestamps: true });

tileSchema.index({ boundingBox: '2dsphere' }, { sparse: true });

export const Tile = mongoose.model('Tile', tileSchema);
export default Tile;
