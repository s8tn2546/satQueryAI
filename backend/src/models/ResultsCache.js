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
  value: { type: Number, required: true }
}, { _id: false });

const resultsCacheSchema = new mongoose.Schema({
  metric: { type: String, required: true },
  region: { type: geoJsonGeometrySchema, required: true },
  dateRange: {
    start: { type: Date, required: true },
    end: { type: Date, required: true }
  },
  series: [seriesItemSchema],
  interval: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
  computedAt: { type: Date, default: Date.now }
}, { timestamps: true });

resultsCacheSchema.index({ region: '2dsphere' });
resultsCacheSchema.index({ metric: 1, 'dateRange.start': 1, 'dateRange.end': 1 });

export const ResultsCache = mongoose.model('ResultsCache', resultsCacheSchema);
export default ResultsCache;
