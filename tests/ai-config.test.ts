/**
 * Agentic AI: the feature is on only with all three keys, and a blank value counts as missing, so an
 * empty variable (KEY= in .env, or a blank one on Railway) turns the feature off instead of stopping
 * the server from starting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NAMES = ['GROQ_API_KEY', 'EBAY_APP_ID', 'EBAY_CERT_ID'] as const;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  for (const k of NAMES) delete process.env[k];
});

describe('aiKeys', () => {
  it('is the three keys when all are set', async () => {
    Object.assign(process.env, { GROQ_API_KEY: 'g', EBAY_APP_ID: 'a', EBAY_CERT_ID: 'c' });
    const { aiKeys } = await import('../src/config/ai.js');
    expect(aiKeys()).toEqual({ groqApiKey: 'g', ebayAppId: 'a', ebayCertId: 'c' });
  });

  it('is null when any one is missing', async () => {
    Object.assign(process.env, { GROQ_API_KEY: 'g', EBAY_APP_ID: 'a' });
    const { aiKeys } = await import('../src/config/ai.js');
    expect(aiKeys()).toBeNull();
  });

  it('treats a blank value as missing instead of failing to start', async () => {
    Object.assign(process.env, { GROQ_API_KEY: '', EBAY_APP_ID: '   ', EBAY_CERT_ID: 'c' });
    const { aiKeys } = await import('../src/config/ai.js');
    expect(aiKeys()).toBeNull();
  });
});
