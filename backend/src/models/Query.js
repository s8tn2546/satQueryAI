import mongoose from 'mongoose';

const executionTraceEntrySchema = new mongoose.Schema({
  step: { type: String, required: true },
  detail: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
}, { _id: false });

const querySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  queryText: { type: String, required: true },
  inputRefs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Tile' }],
  taskType: {
    type: String,
    enum: ['VQA', 'CAPTION', 'GROUNDING', 'CHANGE_ANALYSIS', 'OPTICAL_SAR', 'NDVI', 'NDWI', 'AREA', 'TREND'],
    required: true
  },
  toolsInvoked: [{ type: String }],
  parameters: { type: Object, default: {} },
  result: { type: Object, default: {} },
  evidence: {
    images: [{ type: String }],
    region: { type: Object, default: {} },
    notes: { type: String, default: '' }
  },
  confidence: { type: Number, min: 0, max: 1, default: 0 },
  executionTrace: [executionTraceEntrySchema],
  answerText: { type: String, default: '' },
  status: {
    type: String,
    enum: ['success', 'partial', 'failed', 'rejected'],
    default: 'success'
  }
}, { timestamps: true });

export const Query = mongoose.model('Query', querySchema);
export default Query;
