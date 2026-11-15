/**
 * The dummy gateway itself — a pure function, no mocking needed. See
 * src/services/payment-gateway.service.ts for why the two test-card numbers mirror Stripe's
 * own convention, and why JazzCash, Easypaisa and bank transfer always approve.
 */
import { describe, expect, it } from 'vitest';
import {
  charge, cardHint, walletHint, normalizePkMobile, APPROVED_TEST_CARD, DECLINED_TEST_CARD,
} from '../src/services/payment-gateway.service.js';

describe('charge: card', () => {
  it('approves the designated test card and returns a reference', () => {
    const result = charge({ method: 'CARD', cardNumber: APPROVED_TEST_CARD });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reference).toMatch(/^PAY-/);
    }
  });

  it('declines the reserved card', () => {
    expect(charge({ method: 'CARD', cardNumber: DECLINED_TEST_CARD })).toEqual({ ok: false, reason: 'Your card was declined.' });
  });

  it('tolerates spaces and dashes in the submitted number', () => {
    expect(charge({ method: 'CARD', cardNumber: '4000-0000-0000-0002' }).ok).toBe(false);
    expect(charge({ method: 'CARD', cardNumber: '4242 4242 4242 4242' }).ok).toBe(true);
  });

  it('approves any number other than the reserved declined one', () => {
    expect(charge({ method: 'CARD', cardNumber: '5555555555554444' }).ok).toBe(true);
  });

  it('mints a distinct reference on every successful charge', () => {
    const a = charge({ method: 'CARD', cardNumber: APPROVED_TEST_CARD });
    const b = charge({ method: 'CARD', cardNumber: APPROVED_TEST_CARD });
    expect(a.ok && b.ok && a.reference !== b.reference).toBe(true);
  });

  it('charges a card and keeps only brand + last 4', () => {
    const r = charge({ method: 'CARD', cardNumber: '4242 4242 4242 4242' });
    expect(r).toMatchObject({ ok: true, method: 'CARD', accountHint: 'Visa •••4242', bankTransferReference: null });
  });

  it('card hints: 5 → Mastercard, other → Card', () => {
    expect(cardHint('5555555555554444')).toBe('Mastercard •••4444');
    expect(cardHint('3782822463100051')).toBe('Card •••0051');
  });
});

describe('normalizePkMobile', () => {
  it.each([['+92 300-1234567'], ['92 3001234567'], ['0300 1234567']])('normalises wallet %s', (raw) => {
    expect(normalizePkMobile(raw)).toBe('03001234567');
  });

  it.each([['1234'], ['04001234567'], ['030012345678']])('refuses %s', (raw) => {
    expect(normalizePkMobile(raw)).toBeNull();
  });
});

describe('charge: wallets and bank transfer', () => {
  it('charges JazzCash and Easypaisa with a masked hint', () => {
    expect(charge({ method: 'JAZZCASH', walletNumber: '03001234567' })).toMatchObject({ ok: true, method: 'JAZZCASH', accountHint: '0300•••567' });
    expect(charge({ method: 'EASYPAISA', walletNumber: '03451234567' })).toMatchObject({ ok: true, method: 'EASYPAISA', accountHint: '0345•••567' });
  });

  it('wallet hint keeps the first 4 and last 3 digits', () => {
    expect(walletHint('03001234567')).toBe('0300•••567');
  });

  it('refuses a wallet number that is not a Pakistani mobile (guard behind the request schema)', () => {
    expect(() => charge({ method: 'JAZZCASH', walletNumber: '1234' })).toThrow();
  });

  it('charges a bank transfer and keeps its reference, no hint', () => {
    expect(charge({ method: 'BANK_TRANSFER', bankReference: 'FT2611110001' }))
      .toMatchObject({ ok: true, method: 'BANK_TRANSFER', accountHint: null, bankTransferReference: 'FT2611110001' });
  });
});
