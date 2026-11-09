import { env } from './env.js';

/**
 * The agentic valuation's keys, or null when any is missing: the feature is then off, and the
 * route says so instead of failing (decided 2026-11-09). Read through this, never through
 * `process.env`, so there is one answer to "is the AI configured?".
 */
export interface AiKeys {
  groqApiKey: string;
  ebayAppId: string;
  ebayCertId: string;
}

export function aiKeys(): AiKeys | null {
  const { GROQ_API_KEY, EBAY_APP_ID, EBAY_CERT_ID } = env;
  if (!GROQ_API_KEY || !EBAY_APP_ID || !EBAY_CERT_ID) return null;
  return { groqApiKey: GROQ_API_KEY, ebayAppId: EBAY_APP_ID, ebayCertId: EBAY_CERT_ID };
}

/** Thrown by an AI data source or agent asked to run while the feature is off. */
export class AiNotConfiguredError extends Error {
  constructor() {
    super('The AI valuation is not configured (GROQ_API_KEY, EBAY_APP_ID and EBAY_CERT_ID are needed).');
    this.name = 'AiNotConfiguredError';
  }
}
