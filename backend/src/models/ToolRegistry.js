import mongoose from 'mongoose';

const toolRegistrySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, index: true },
  description: { type: String, required: true },
  requiredInputs: [{ type: String }],
  acceptedModalities: [{ type: String }],
  parameters: { type: Object, default: {} },
  endpoint: { type: String, required: true },
  outputSchema: { type: Object, default: {} }
}, { timestamps: true });

export const ToolRegistry = mongoose.model('ToolRegistry', toolRegistrySchema);
export default ToolRegistry;
