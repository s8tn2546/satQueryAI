import mongoose from 'mongoose';

const geoJsonPolygonSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['Polygon'],
    default: 'Polygon'
  },
  coordinates: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  }
}, { _id: false });

const tileSchema = new mongoose.Schema({
  source: {
    type: String,
    enum: ['sentinel-2', 'bhuvan', 'cartosat-2s', 'risat', 'benchmark-upload', 'gee-fetch'],
    default: 'benchmark-upload'
  },
  modality: {
    type: String,
    enum: ['optical', 'sar'],
    required: true
  },
  format: {
    type: String,
    required: true
  },
  captureDate: { type: Date, default: null },
  boundingBox: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  crs: { type: String, default: null },
  resolution: { type: Number, default: null },
  bands: { type: [String], default: [] },
  filePath: { type: String, required: true },
  validated: { type: Boolean, default: false },
  validationDetails: { type: Object, default: {} }
}, { timestamps: true });

export const Tile = mongoose.model('Tile', tileSchema);
export default Tile;
