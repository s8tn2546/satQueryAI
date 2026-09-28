import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { connectDB, disconnectDB } from './services/db.js';
import { reconcileStaleJobs } from './services/queryJobQueue.js';
import { authMiddleware } from './middleware/auth.js';
import { assertStartupConfig, corsOrigins, trustProxySetting, isProduction } from './config.js';
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

app.disable('x-powered-by');

// CORS: explicit origin allowlist only. An origin outside the list gets no
// access-control headers; non-browser callers (curl, server-to-server) send no
// Origin header and are unaffected. credentials are never enabled, so no
// wildcard policy can be combined with cookies/authorization side effects.
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, false);
      return cb(null, corsOrigins().includes(origin));
    },
    credentials: false
  })
);

// Security headers. CORP stays cross-origin because browsers load tile /
// preview images from this backend cross-origin; CSP is left to the frontend
// serving layer rather than guessed here.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false
  })
);

// Bounded request bodies: a JSON body beyond ~2MB is almost certainly not a
// query, and oversized form bodies are dropped before any handler runs.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Proxy hops come from config, never assumed — rate limiters need the real
// client IP in production.
const proxySetting = trustProxySetting();
if (proxySetting !== false) {
  app.set('trust proxy', proxySetting);
}

app.use(authMiddleware);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'satquery-backend' });
});

function limiterOptions(overrides = {}) {
  return {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX) || 300,
    standardHeaders: true,
    legacyHeaders: false,
    // Never throttle /health and never throttle the test suite.
    skip: req => req.path === '/health' || process.env.NODE_ENV === 'test',
    handler: (req, res) =>
      res.status(429).json({ status: 'failed', error: 'Too many requests. Please retry shortly.' }),
    ...overrides
  };
}

// General API guard.
app.use('/api', rateLimit(limiterOptions()));

// Stricter guards on mutation-heavy / credential-bearing routes.
app.use(
  '/api/auth',
  rateLimit(limiterOptions({ max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 30 }))
);
app.use(
  '/api/query',
  rateLimit(limiterOptions({ max: Number(process.env.QUERY_RATE_LIMIT_MAX) || 60 }))
);
app.use(
  '/api/images/upload',
  rateLimit(limiterOptions({ max: Number(process.env.UPLOAD_RATE_LIMIT_MAX) || 30 }))
);

app.use('/api/auth', authRouter);
app.use('/api/images', imagesRouter);
app.use('/api/query', queryRouter);
app.use('/api/tools', toolsRouter);
app.use('/api/stac', stacRouter);
app.use('/api/tiles', tilesRouter);
app.use('/api/ml', mlRouter);

// JSON 404 for anything unmatched; never HTML.
app.use((req, res) => {
  res.status(404).json({ status: 'failed', error: 'Route not found.' });
});

// Central error handler: JSON responses, no stack traces or internal messages
// leaked to clients.
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ status: 'failed', error: 'Request body is too large.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ status: 'failed', error: 'Malformed request body.' });
  }
  if (err && err.statusCode === 429) {
    return res.status(429).json({ status: 'failed', error: 'Too many requests. Please retry shortly.' });
  }
  console.error('[ErrorHandler]', err?.message || err);
  return res.status(500).json({ status: 'failed', error: 'An internal server error occurred.' });
});

let server;

export const startServer = async () => {
  if (server) return server;

  // Fail fast on missing production configuration BEFORE binding a port.
  assertStartupConfig();

  if (!isProduction()) {
    console.warn(
      '[Config] Running outside production: auth uses the dev-only JWT secret and default service URLs. Set JWT_SECRET / MONGODB_URI (and CORS_ORIGINS / TRUST_PROXY) for production.'
    );
  }

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
  server.on('error', err => {
    console.error('[SatQuery Backend] Failed to start server:', err?.message || err);
    process.exit(1);
  });
  return server;
};

function shutdown(signal) {
  console.log(`[SatQuery Backend] Received ${signal}; shutting down...`);
  server?.close(closeErr => {
    if (closeErr) {
      console.error('[SatQuery Backend] Error during shutdown:', closeErr?.message || closeErr);
      process.exit(1);
    }
    disconnectDB().finally(() => process.exit(0));
  });
  // Hard-stop watchdog in case in-flight work never yields.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (process.env.NODE_ENV !== 'test' && process.argv[1] && process.argv[1].endsWith('index.js')) {
  startServer();
}

export default app;