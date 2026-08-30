import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './services/db.js';
import imagesRouter from './routes/images.js';
import queryRouter from './routes/query.js';
import toolsRouter from './routes/tools.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'satquery-backend' });
});

app.use('/api/images', imagesRouter);
app.use('/api/query', queryRouter);
app.use('/api/tools', toolsRouter);

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
