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
  validationDetails: { type: Object, default: {} },
  // Spatial-readiness state as observed at upload. `null` means "not
  // determined" (the file was not decoded); it is never defaulted to false,
  // which would misreport an unverified file as a known non-georeferenced one.
  isGeoreferenced: { type: Boolean, default: null },
  // 'georeferenced_analysis_ready' | 'visual_only_valid' | 'invalid' | 'unverified'
  integrity: { type: String, default: null },
  metadata: { type: Object, default: {} }
}, { timestamps: true });

export const Tile = mongoose.model('Tile', tileSchema);
export default Tile;
