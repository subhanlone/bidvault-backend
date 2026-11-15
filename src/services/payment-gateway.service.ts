import { randomBytes } from 'node:crypto';

/**
 * A self-built, fully-simulated payment gateway.
 *
 * Stripe is UAE-registered and does not support Pakistan; this platform never moved real money
 * through it (see the removed stripe.service.ts / project history). Nothing here talks to any
 * external service — a charge is decided purely by which test card number was submitted, and
 * resolves synchronously in the same request. There is deliberately no webhook, no async
 * confirmation step, and no client secret: the old two-step "create an intent, then confirm it"
 * shape existed only because a real processor's own UI (Stripe Elements) had to run in the
 * buyer's browser first.
 *
 * The two reserved numbers mirror Stripe's own test-card convention on purpose, so the existing
 * "Test card: ..." hint in the UI and the existing declined-card retry path (BV-006) still mean
 * the same thing to a user testing the flow -- only now it is genuinely this app deciding the
 * outcome, not a remote sandbox.
 */

import type { PaymentMethod } from '@prisma/client';

export const APPROVED_TEST_CARD = '4242424242424242';
export const DECLINED_TEST_CARD = '4000000000000002';

/**
 * JazzCash, Easypaisa and bank transfer are simulated the same way as the card, but always
 * approve: the user chose no OTP/MPIN step, no wallet decline number and no admin check of bank
 * transfers. The card keeps its reserved decline number, so the declined-card retry path stays
 * testable.
 */
export type ChargeInput =
  | { method: 'CARD'; cardNumber: string }
  | { method: 'JAZZCASH' | 'EASYPAISA'; walletNumber: string }
  | { method: 'BANK_TRANSFER'; bankReference: string };

export type ChargeResult =
  | { ok: true; reference: string; method: PaymentMethod; accountHint: string | null; bankTransferReference: string | null }
  | { ok: false; reason: string };

/**
 * A Pakistani mobile number in the one stored shape, 03XXXXXXXXX (11 digits), or null. Accepts
 * +92 3…, 92 3… and 03…, with spaces and dashes. Any network: both wallets take any number.
 */
export function normalizePkMobile(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '').replace(/^\+/, '');
  const local = digits.startsWith('92') ? `0${digits.slice(2)}` : digits;
  return /^03\d{9}$/.test(local) ? local : null;
}

/** The only trace of a card that is kept: brand from the first digit, plus the last 4. */
export function cardHint(cardNumber: string): string {
  const digits = cardNumber.replace(/[\s-]/g, '');
  const brand = digits.startsWith('4') ? 'Visa' : digits.startsWith('5') ? 'Mastercard' : 'Card';
  return `${brand} •••${digits.slice(-4)}`;
}

/** The only trace of a wallet number that is kept: the first 4 and last 3 digits. */
export function walletHint(normalized: string): string {
  return `${normalized.slice(0, 4)}•••${normalized.slice(-3)}`;
}

function paymentReference(): string {
  return `PAY-${randomBytes(9).toString('base64url')}`;
}

/** The full card or mobile number is never stored or returned: a real gateway would not keep it
 * either, and there is no reason for this one to start the habit just because it is a
 * simulation. Only the masked hint leaves this function. */
export function charge(input: ChargeInput): ChargeResult {
  switch (input.method) {
    case 'CARD': {
      if (input.cardNumber.replace(/[\s-]/g, '') === DECLINED_TEST_CARD) {
        return { ok: false, reason: 'Your card was declined.' };
      }
      return { ok: true, reference: paymentReference(), method: 'CARD', accountHint: cardHint(input.cardNumber), bankTransferReference: null };
    }
    case 'JAZZCASH':
    case 'EASYPAISA': {
      // The request schema has already normalised the number; this guard keeps a caller that
      // skipped it from storing a hint of something that is not a mobile number.
      const normalized = normalizePkMobile(input.walletNumber);
      if (!normalized) throw new Error('charge: walletNumber is not a Pakistani mobile number');
      return { ok: true, reference: paymentReference(), method: input.method, accountHint: walletHint(normalized), bankTransferReference: null };
    }
    case 'BANK_TRANSFER':
      return { ok: true, reference: paymentReference(), method: 'BANK_TRANSFER', accountHint: null, bankTransferReference: input.bankReference };
  }
}
