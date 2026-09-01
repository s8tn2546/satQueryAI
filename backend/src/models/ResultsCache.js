import mongoose from 'mongoose';

const seriesItemSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  value: { type: Number, required: true }
}, { _id: false });

const resultsCacheSchema = new mongoose.Schema({
  tool: { type: String, required: true },
  parameters: { type: Object, required: true },
  result: { type: Object, required: true },
  evidence: { type: Object, default: {} },
  confidence: { type: Number, min: 0, max: 1, default: 0 },
  metadata: { type: Object, default: {} },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

resultsCacheSchema.index({ tool: 1, parameters: 1 });
resultsCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ResultsCache = mongoose.model('ResultsCache', resultsCacheSchema);
export default ResultsCache;
