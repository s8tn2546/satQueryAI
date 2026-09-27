/**
 * Single source of truth for LLM configuration and mock detection.
 *
 * Why this exists: `answerComposer` and `intentClassifier` each had their own
 * inline `isMock` check that only recognised `mock*`. The repo ships
 * `LLM_API_KEY=demo` in backend/.env, which that check did NOT match, so both
 * agents attempted a real API call with the literal string "demo", received an
 * authentication error, and silently fell back to heuristics. The trace said
 * `[fallback]` with no indication that the configuration itself was the problem.
 *
 * Everything that decides whether a real LLM call happens must go through
 * `isLlmMocked`, so the answer path and the classification path can never
 * disagree about the mode.
 */

/** Trace-visible answer/classification modes. */
export const LLM_MODE = Object.freeze({
  LLM: 'LLM',
  MOCK: 'MOCK',
  FALLBACK: 'FALLBACK'
});

/**
 * Keys that are placeholders rather than credentials. Compared
 * case-insensitively against the trimmed key.
 *
 * `your_llm_api_key` comes from backend/.env.example: shipping it verbatim in a
 * real deployment would otherwise produce the same silent-auth-failure loop.
 */
const PLACEHOLDER_KEYS = new Set([
  '',
  'demo',
  'dummy',
  'fake',
  'mock',
  'none',
  'null',
  'nil',
  'undefined',
  'test',
  'testing',
  'placeholder',
  'changeme',
  'change-me',
  'your_llm_api_key',
  'your-api-key',
  'xxx',
  'todo'
]);

/** Prefixes that mark a key as a test/demo credential. */
const PLACEHOLDER_PREFIXES = ['mock', 'test', 'fake', 'demo', 'dummy', 'placeholder'];

/**
 * True when the supplied key cannot possibly be a real credential.
 *
 * @param {string|undefined|null} key
 * @returns {boolean}
 */
export function isLlmMocked(key) {
  if (key === undefined || key === null) return true;
  if (typeof key !== 'string') return true;

  const normalized = key.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (PLACEHOLDER_KEYS.has(normalized)) return true;
  if (PLACEHOLDER_PREFIXES.some(prefix => normalized.startsWith(prefix))) return true;

  return false;
}

/**
 * Why a key was treated as a mock, for the execution trace. Never leaks the key.
 *
 * @param {string|undefined|null} key
 * @returns {string|null} the reason, or null when the key looks like a real
 *   credential (i.e. there is nothing to report).
 */
export function describeMockReason(key) {
  if (key === undefined || key === null) return 'no API key configured';
  if (typeof key !== 'string') return 'API key is not a string';
  const normalized = key.trim().toLowerCase();
  if (normalized.length === 0) return 'API key is empty';
  if (PLACEHOLDER_KEYS.has(normalized)) return 'API key is a placeholder value';
  const prefix = PLACEHOLDER_PREFIXES.find(p => normalized.startsWith(p));
  if (prefix) return `API key uses the "${prefix}" placeholder convention`;
  return null;
}

/**
 * Resolve provider, model and mock state.
 *
 * Provider resolution is intentionally unchanged from the previous inline
 * logic: GROQ_API_KEY wins and forces the groq provider, otherwise
 * LLM_PROVIDER is honoured, defaulting to anthropic.
 *
 * @param {object} [env] environment to read; defaults to process.env
 */
export function resolveLlmConfig(env = process.env) {
  const groqKey = env.GROQ_API_KEY;
  const apiKey = groqKey || env.LLM_API_KEY;
  const provider = groqKey ? 'groq' : (env.LLM_PROVIDER || 'anthropic');
  const model = provider === 'groq'
    ? (env.GROQ_MODEL || 'gptoss-120b')
    : (env.LLM_MODEL || 'claude-3-5-haiku-20241022');
  const mocked = isLlmMocked(apiKey);

  return {
    apiKey,
    provider,
    model,
    mocked,
    source: groqKey ? 'GROQ_API_KEY' : (env.LLM_API_KEY ? 'LLM_API_KEY' : 'none'),
    mockReason: mocked ? describeMockReason(apiKey) : null,
    // Max output tokens: sized for the dynamic answer target, not a fixed
    // budget. 180-350 words needs well over 512 tokens once headings and
    // structure are included.
    maxTokens: Number(env.LLM_MAX_TOKENS) || 2048
  };
}

/**
 * Trace-friendly one-line description of the resolved mode.
 *
 * @param {ReturnType<typeof resolveLlmConfig>} config
 * @param {string} stage e.g. 'answer generation' / 'intent classification'
 * @param {LLM_MODE[keyof LLM_MODE]} mode
 */
export function describeLlmMode(config, stage, mode) {
  if (mode === LLM_MODE.MOCK) {
    return `[${mode}] ${stage} used deterministic local logic: ${config.mockReason}. No LLM call was attempted.`;
  }
  if (mode === LLM_MODE.FALLBACK) {
    return `[${mode}] ${stage} attempted an LLM call (${config.provider}/${config.model}) but it failed; degraded to a labelled factual response.`;
  }
  return `[${mode}] ${stage} used the ${config.provider} provider (${config.model}), key from ${config.source}.`;
}
