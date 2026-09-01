import mongoose from 'mongoose';

const geoJsonGeometrySchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['Point', 'Polygon', 'MultiPolygon'],
    required: true
  },
  coordinates: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  }
}, { _id: false });

const seriesItemSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  value: { type: Number, default: null }
}, { _id: false, strict: false });

const resultsCacheSchema = new mongoose.Schema({
  tool: { type: String, required: true },
  metric: { type: String, lowercase: true },
  region: { type: geoJsonGeometrySchema },
  regionKey: { type: String },
  dateRange: {
    start: { type: Date },
    end: { type: Date }
  },
  series: [seriesItemSchema],
  interval: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
  parameters: { type: Object, required: true },
  result: { type: Object, required: true },
  evidence: { type: Object, default: {} },
  confidence: { type: Number, min: 0, max: 1, default: 0 },
  metadata: { type: Object, default: {} },
  expiresAt: { type: Date, required: true },
  computedAt: { type: Date, default: Date.now }
}, { timestamps: true });

resultsCacheSchema.index({ tool: 1, 'parameters.hash': 1 });
resultsCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
resultsCacheSchema.index({ region: '2dsphere' });
resultsCacheSchema.index({ metric: 1, 'dateRange.start': 1, 'dateRange.end': 1, regionKey: 1 });

export const ResultsCache = mongoose.model('ResultsCache', resultsCacheSchema);
export default ResultsCache;
