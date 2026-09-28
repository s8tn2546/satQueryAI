import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './services/db.js';
import { reconcileStaleJobs } from './services/queryJobQueue.js';
import { authMiddleware } from './middleware/auth.js';
import imagesRouter from './routes/images.js';
import queryRouter from './routes/query.js';
import toolsRouter from './routes/tools.js';
import authRouter from './routes/auth.js';
import stacRouter from './routes/stac.js';
import tilesRouter from './routes/tiles.js';
import mlRouter from './routes/ml.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'satquery-backend' });
});

app.use('/api/auth', authRouter);
app.use('/api/images', imagesRouter);
app.use('/api/query', queryRouter);
app.use('/api/tools', toolsRouter);
app.use('/api/stac', stacRouter);
app.use('/api/tiles', tilesRouter);
app.use('/api/ml', mlRouter);

let server;

export const startServer = async () => {
  if (!server) {
    await connectDB();
    // Async jobs persist in Mongo; any job left queued/running by a previous
    // process is marked failed so it is never silently re-executed.
    try {
      const reconciled = await reconcileStaleJobs();
      if (reconciled.modifiedCount > 0) {
        console.log(`[SatQuery Backend] Recovered ${reconciled.modifiedCount} stale async job(s) at startup`);
      }
    } catch (err) {
      console.error('[SatQuery Backend] Failed to reconcile stale async jobs:', err?.message || err);
    }
    server = app.listen(PORT, () => {
      console.log(`[SatQuery Backend] Server running on port ${PORT}`);
    });
  }
  return server;
};

if (process.env.NODE_ENV !== 'test' && process.argv[1] && process.argv[1].endsWith('index.js')) {
  startServer();
}

export default app;
