import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String },
  preferences: {
    defaultRegion: { type: Object, default: {} },
    units: { type: String, default: 'metric' }
  }
}, { timestamps: true });

export const User = mongoose.model('User', userSchema);
export default User;
