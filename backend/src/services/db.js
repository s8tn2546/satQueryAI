import mongoose from 'mongoose';
import { seedTools } from './seedTools.js';

let mongoMemoryServer = null;

export const connectDB = async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/satquery';
  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 1000
    });
    console.log(`[MongoDB] Connected: ${conn.connection.host}`);
    await seedTools();
    return conn;
  } catch (error) {
    console.warn(`[MongoDB] Primary connection failed (${error.message}). Starting in-memory Mongo server fallback...`);
    await mongoose.disconnect();
    try {
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      mongoMemoryServer = await MongoMemoryServer.create();
      const mongoUri = mongoMemoryServer.getUri();
      const conn = await mongoose.connect(mongoUri);
      console.log(`[MongoDB] Connected to in-memory instance: ${mongoUri}`);
      await seedTools();
      return conn;
    } catch (memErr) {
      console.error(`[MongoDB] In-memory server fallback failed: ${memErr.message}`);
      process.exit(1);
    }
  }
};

export const disconnectDB = async () => {
  await mongoose.disconnect();
  if (mongoMemoryServer) {
    await mongoMemoryServer.stop();
  }
};
