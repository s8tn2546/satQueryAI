import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './services/db.js';
import { authMiddleware } from './middleware/auth.js';
import imagesRouter from './routes/images.js';
import queryRouter from './routes/query.js';
import toolsRouter from './routes/tools.js';
import authRouter from './routes/auth.js';
import trendRouter from './routes/trend.js';
import fetchImageryRouter from './routes/fetch-imagery.js';

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
app.use('/api/query/trend', trendRouter);
app.use('/api/images/fetch-by-region', fetchImageryRouter);

let server;

export const startServer = async () => {
  if (!server) {
    await connectDB();
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
