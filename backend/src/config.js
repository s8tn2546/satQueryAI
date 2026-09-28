import dotenv from 'dotenv';

dotenv.config();

export const NODE_ENV = process.env.NODE_ENV || 'development';

export function isProduction() {
  return NODE_ENV === 'production';
}

/**
 * Dev-only signing/verification secret. Never used in production: a known
 * constant would let anyone forge tokens, so production config validation
 * fails hard instead (see assertStartupConfig).
 */
const DEV_JWT_SECRET = 'satquery-dev-only-signing-secret-not-for-production';

/**
 * Resolve the JWT secret.
 * - Production: the secret MUST come from the environment, otherwise this
 *   throws. A known constant is not acceptable for a deployed service.
 * - Otherwise: a documented dev-only constant keeps local runs and test suites
 *   working without configuration. startServer warns that this is not
 *   production-hardened.
 */
export function resolveJwtSecret(env = process.env) {
  const secret = env.JWT_SECRET;
  if (secret && String(secret).trim()) return String(secret).trim();
  if (env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production. Refusing to use a known default secret.');
  }
  return DEV_JWT_SECRET;
}

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174'
];

/**
 * CORS origin allowlist. Comma-separated CORS_ORIGINS overrides the dev
 * defaults. Empty/false means the allowlist is exactly the dev defaults.
 */
export function corsOrigins(env = process.env) {
  const raw = env.CORS_ORIGINS;
  if (!raw || !String(raw).trim()) return DEFAULT_CORS_ORIGINS;
  return String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Trust-proxy setting for Express, derived from TRUST_PROXY. Parses boolean /
 * hop-count forms; absent config means no proxy hops (rate limiters key on the
 * socket address).
 */
export function trustProxySetting(env = process.env) {
  const raw = env.TRUST_PROXY;
  if (!raw || !String(raw).trim()) return false;
  const v = String(raw).trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  const asInt = Number.parseInt(v, 10);
  return Number.isFinite(asInt) ? asInt : String(raw).trim();
}

/**
 * Validate required production configuration before the server binds a port.
 * Called from startServer() only — the test path imports the app without ever
 * starting it, so unit tests never trip these checks.
 */
export function assertStartupConfig(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const missing = [];
  if (!env.MONGODB_URI || !String(env.MONGODB_URI).trim()) missing.push('MONGODB_URI');
  if (!env.JWT_SECRET || !String(env.JWT_SECRET).trim()) missing.push('JWT_SECRET');
  if (missing.length > 0) {
    throw new Error(
      `Missing required production configuration: ${missing.join(', ')}. Refusing to start.`
    );
  }
  resolveJwtSecret(env);
}