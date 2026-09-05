/**
 * The dummy gateway itself — a pure function, no mocking needed. See
 * src/services/payment-gateway.service.ts for why the two test-card numbers mirror Stripe's
 * own convention.
 */
import { describe, expect, it } from 'vitest';
import { chargeCard, APPROVED_TEST_CARD, DECLINED_TEST_CARD } from '../src/services/payment-gateway.service.js';

describe('chargeCard', () => {
  it('approves the designated test card and returns a reference', () => {
    const result = chargeCard(APPROVED_TEST_CARD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reference).toMatch(/^PAY-/);
    }
  });

  it('declines the designated test card', () => {
    const result = chargeCard(DECLINED_TEST_CARD);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('Your card was declined.');
    }
  });

  it('tolerates spaces and dashes in the submitted number', () => {
    expect(chargeCard('4000-0000-0000-0002').ok).toBe(false);
    expect(chargeCard('4242 4242 4242 4242').ok).toBe(true);
  });

  it('approves any number other than the reserved declined one', () => {
    expect(chargeCard('5555555555554444').ok).toBe(true);
  });

  it('mints a distinct reference on every successful charge', () => {
    const a = chargeCard(APPROVED_TEST_CARD);
    const b = chargeCard(APPROVED_TEST_CARD);
    expect(a.ok && b.ok && a.reference !== b.reference).toBe(true);
  });
});
