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

export const APPROVED_TEST_CARD = '4242424242424242';
export const DECLINED_TEST_CARD = '4000000000000002';

export type ChargeResult =
  | { ok: true; reference: string }
  | { ok: false; reason: string };

/** Never stored: a real gateway would not persist a card number either, and there is no reason
 * for this one to start the habit just because it is a simulation. */
export function chargeCard(cardNumber: string): ChargeResult {
  const normalized = cardNumber.replace(/[\s-]/g, '');

  if (normalized === DECLINED_TEST_CARD) {
    return { ok: false, reason: 'Your card was declined.' };
  }

  return { ok: true, reference: `PAY-${randomBytes(9).toString('base64url')}` };
}
