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
    enum: ['sentinel-2', 'landsat-8', 'landsat-9', 'bhuvan', 'cartosat-2s', 'risat', 'benchmark-upload', 'gee-fetch'],
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
  // STAC acquisition provenance (present only for /stac/ingest tiles).
  // `provider` names the pipeline that produced the tile ('stac' /
  // 'stac-fixture' / 'gee'); `sceneId` and `collection` preserve the provider's
  // original identifiers for traceability.
  provider: { type: String, default: null },
  sceneId: { type: String, default: null },
  collection: { type: String, default: null },
  // Authoritative georeferenced analysis raster (the file the analytics tools
  // actually consume). `filePath` is kept in sync for backwards compatibility.
  analysisRaster: { type: String, default: null },
  // Derived rasters, e.g. { png: '<abs path>', channels: [...], stretch: ... }.
  // The preview is a rendering aid and never replaces the analysis raster.
  previews: { type: Object, default: {} },
  // The AOI geometry this tile was acquired over (GeoJSON) and its CRS.
  aoi: { type: mongoose.Schema.Types.Mixed, default: null },
  aoiCrs: { type: String, default: null },
  // Deterministic dedupe key produced by the ML service; unique among tiles so
  // the same scene+AOI+bands+CRS is never ingested twice. No default: a doc
  // without this key must remain absent from the unique sparse index (a
  // default of null would index null and make every legacy tile a collision).
  dedupeKey: { type: String },
  metadata: { type: Object, default: {} }
}, { timestamps: true });

tileSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

export const Tile = mongoose.model('Tile', tileSchema);
export default Tile;
