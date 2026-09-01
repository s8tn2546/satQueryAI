import mongoose from 'mongoose';

const geoJsonGeometrySchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['Polygon', 'MultiPolygon'],
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
  metric: { type: String, required: true, lowercase: true },
  region: { type: geoJsonGeometrySchema, required: true },
  regionKey: { type: String },
  dateRange: {
    start: { type: Date, required: true },
    end: { type: Date, required: true }
  },
  series: [seriesItemSchema],
  interval: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
  confidence: { type: Number, min: 0, max: 1, default: 0 },
  evidence: { type: mongoose.Schema.Types.Mixed, default: {} },
  result: { type: mongoose.Schema.Types.Mixed, default: {} },
  computedAt: { type: Date, default: Date.now }
}, { timestamps: true });

resultsCacheSchema.index({ region: '2dsphere' });
resultsCacheSchema.index({ metric: 1, 'dateRange.start': 1, 'dateRange.end': 1, regionKey: 1 });
resultsCacheSchema.index({ metric: 1, regionKey: 1, 'dateRange.start': 1, 'dateRange.end': 1 }, { unique: true });

export const ResultsCache = mongoose.model('ResultsCache', resultsCacheSchema);
export default ResultsCache;
