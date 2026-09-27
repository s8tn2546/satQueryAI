import { LLM_MODE, describeMockReason, isLlmMocked, resolveLlmConfig } from '../src/utils/llmConfig.js';

const REAL_KEY = 'sk-real-abcdef0123456789';

function env(overrides = {}) {
  // Minimal realistic env: a real key, Anthropic by default.
  const base = { GROQ_API_KEY: '', LLM_API_KEY: REAL_KEY, LLM_PROVIDER: '' };
  return { ...base, ...overrides };
}

describe('isLlmMocked', () => {
  test('no key at all is mocked', () => {
    expect(isLlmMocked(undefined)).toBe(true);
    expect(isLlmMocked('')).toBe(true);
  });

  test('the known placeholders are mocked', () => {
    for (const key of ['mock', 'mock-llm-key', 'test', 'demo', 'placeholder', 'changeme', 'your-api-key']) {
      expect(isLlmMocked(key)).toBe(true);
    }
  });

  test('placeholder detection is case-insensitive and prefix-based', () => {
    expect(isLlmMocked('DEMO')).toBe(true);
    expect(isLlmMocked('  demo  ')).toBe(true);
    expect(isLlmMocked('mock-anything')).toBe(true);
  });

  test('a real key is not mocked', () => {
    expect(isLlmMocked(REAL_KEY)).toBe(false);
    expect(isLlmMocked('sk-ant-api03-xyz')).toBe(false);
  });

  test('a real key that merely contains "test" is not mocked', () => {
    expect(isLlmMocked('sk-test-1234567890abcdef')).toBe(false);
  });

  test('describeMockReason explains why', () => {
    expect(describeMockReason('demo')).toMatch(/placeholder/i);
    expect(describeMockReason('')).toMatch(/empty/i);
    // A real key has no reason to report.
    expect(describeMockReason(REAL_KEY)).toBeNull();
  });
});

describe('resolveLlmConfig', () => {
  test('a real key produces a live anthropic config by default', () => {
    const config = resolveLlmConfig(env());
    expect(config.mocked).toBe(false);
    expect(config.provider).toBe('anthropic');
    expect(config.apiKey).toBe(REAL_KEY);
  });

  test('the "demo" key in the checked-in .env is reported as mocked', () => {
    // Regression: LLM_API_KEY=demo previously attempted a real API call,
    // failed on auth, and fell back silently.
    const config = resolveLlmConfig(env({ LLM_API_KEY: 'demo', LLM_PROVIDER: 'openai' }));
    expect(config.mocked).toBe(true);
    expect(config.provider).toBe('openai');
  });

  test('GROQ_API_KEY forces the groq provider even when LLM_PROVIDER disagrees', () => {
    const config = resolveLlmConfig(env({ GROQ_API_KEY: 'gsk-real-123', LLM_PROVIDER: 'anthropic' }));
    expect(config.provider).toBe('groq');
    expect(config.apiKey).toBe('gsk-real-123');
  });

  test('a groq placeholder key is still mocked, not called', () => {
    const config = resolveLlmConfig(env({ GROQ_API_KEY: 'mock', LLM_API_KEY: REAL_KEY }));
    expect(config.mocked).toBe(true);
  });

  test('LLM_PROVIDER selects the provider when no groq key is set', () => {
    expect(resolveLlmConfig(env({ LLM_PROVIDER: 'openai' })).provider).toBe('openai');
  });
});

describe('LLM_MODE', () => {
  test('exposes the three explicit execution modes, uppercase for the trace', () => {
    expect(LLM_MODE.LLM).toBe('LLM');
    expect(LLM_MODE.MOCK).toBe('MOCK');
    expect(LLM_MODE.FALLBACK).toBe('FALLBACK');
  });
});
