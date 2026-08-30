import { Router } from 'express';
import Stripe from 'stripe';
import type { TransactionStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { validateBody } from '../../middleware/validate.js';
import { createIntentSchema } from '../../openapi/requests.js';
import { dispatchEmail, sendPaymentCompletedEmail } from '../../services/email.service.js';

const router = Router();

// The API version is pinned rather than left to whatever the installed SDK defaults to.
// `stripe` is declared as ^22.1.1, so a routine `npm install` could otherwise move the
// version this payment path talks to with no code change — and the webhook handler reads
// `event.data.object`, whose shape is exactly what an API version governs.
// Pinned to the version the installed SDK's own types describe, so the runtime API and the
// compile-time shapes cannot disagree. Changing it is a deliberate act: bump both together.
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2026-07-29.dahlia' });

/**
 * Money, at the Stripe boundary.
 *
 * The domain stores whole rupees everywhere -- Bid.amount, Auction.currentBid,
 * AuctionTransaction.finalAmount are all integer PKR, which is the right choice. Stripe
 * expects the smallest unit of the currency, and PKR is two-decimal, so the two disagree by
 * a factor of 100.
 *
 * That disagreement was the audit's one Critical finding: `amount: tx.finalAmount` charged
 * PKR 50 for a PKR 5,000 sale while the books recorded the full 5,000. Stripe's own error
 * settled it, formatting the unconverted integer back as "₨50.00".
 *
 * Named, and used on both sides of the round trip -- the webhook checks what actually
 * arrived against the same conversion -- so the two can never drift apart again.
 */
const CURRENCY = 'pkr';
const MINOR_UNITS_PER_RUPEE = 100;

function toMinorUnits(wholeRupees: number): number {
  return wholeRupees * MINOR_UNITS_PER_RUPEE;
}

router.get(
  '/my-wins',
  requireAuth(['BUYER']),
  asyncHandler(async (req, res) => {
    const winnerId = req.auth!.userId;

    const transactions = await prisma.auctionTransaction.findMany({
      where: { winnerId },
      include: {
        auction: true,
        seller: { select: { name: true, email: true } },
        review: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    ok(res, transactions.map((tx) => ({
      transactionId: tx.id,
      auctionId: tx.auctionId,
      auctionTitle: tx.auction.title,
      auctionEmoji: tx.auction.emoji ?? '📦',
      auctionImageUrl: tx.auction.imageUrl ?? '',
      sellerName: tx.seller.name,
      finalAmount: tx.finalAmount,
      status: tx.status,
      // Why the last attempt failed, if one did. Published rather than left in the database:
      // a buyer whose card was declined needs to know it was declined and can be retried,
      // which is the whole point of not writing FAILED into `status` any more.
      lastPaymentError: tx.lastPaymentError ?? undefined,
      createdAt: tx.createdAt.toISOString(),
      reviewed: tx.review !== null,
    })));
  }),
);

router.get(
  '/seller-stats',
  requireAuth(['SELLER']),
  asyncHandler(async (req, res) => {
    const sellerId = req.auth!.userId;
    const txs = await prisma.auctionTransaction.findMany({
      where: { sellerId, status: 'COMPLETED' },
      select: { finalAmount: true },
    });
    ok(res, {
      totalRevenue: txs.reduce((sum, tx) => sum + tx.finalAmount, 0),
      itemsSold: txs.length,
    });
  }),
);

router.post(
  '/create-intent',
  requireAuth(['BUYER']),
  // The only route that used to validate its body by hand. Three problems with that: the
  // contract's schema and the enforced rule were separate objects and free to drift, the
  // check accepted any truthy value where the contract says string, and the 400 it sent was
  // an ErrorResponse while the contract documents a ValidationError.
  validateBody(createIntentSchema),
  asyncHandler(async (req, res) => {
    const winnerId = req.auth!.userId;
    const { transactionId } = req.body;

    let outcome: { kind: 'ok'; clientSecret: string | null } | { kind: 'fail'; message: string; status: number };

    // The whole read-decide-write runs under a row lock. Without it the read at the top and
    // the write at the bottom are separated by a network call to Stripe, and two concurrent
    // calls — a double-clicked Pay button is enough — both see stripePaymentIntentId as null,
    // both create an intent, and the second overwrites the first. If the buyer then pays the
    // *first* one, the webhook looks it up by the stored id, finds nothing, and answers 200.
    // Money taken, transaction still PENDING, nothing logged. Same FOR UPDATE pattern the bid
    // path has used since NEW-09.
    try {
      outcome = await prisma.$transaction(async (dbTx) => {
        const [row] = await dbTx.$queryRaw<Array<{
          id: string;
          winnerId: string;
          auctionId: string;
          finalAmount: number;
          status: TransactionStatus;
          stripePaymentIntentId: string | null;
        }>>`
          SELECT id, "winnerId", "auctionId", "finalAmount", status, "stripePaymentIntentId"
          FROM "AuctionTransaction"
          WHERE id = ${transactionId}
          FOR UPDATE
        `;

        if (!row) return { kind: 'fail' as const, message: 'Transaction not found.', status: 404 };
        if (row.winnerId !== winnerId) return { kind: 'fail' as const, message: 'Forbidden.', status: 403 };

        // FAILED is retryable. A declined card is an ordinary event, and refusing it here was
        // what made one decline permanent — see BV-006 and the lastPaymentError column.
        // COMPLETED is genuinely terminal.
        if (row.status === 'COMPLETED') {
          return { kind: 'fail' as const, message: 'This purchase has already been paid for.', status: 409 };
        }

        if (row.stripePaymentIntentId) {
          const existing = await stripe.paymentIntents.retrieve(row.stripePaymentIntentId);

          // Reusable only if all three hold.
          //
          // The amount check is not defensive padding: every PaymentIntent created before
          // BV-001 was fixed carries the *unconverted* rupee figure. Returning one of those
          // client secrets would charge 1/100th of the debt with the corrected code in place
          // — so the Critical bug would survive precisely for the transactions that already
          // had an intent, which is the likeliest population to exist in production.
          //
          // A canceled or already-succeeded intent cannot be confirmed again either;
          // returning its secret fails inside Stripe.js with a message meaning nothing to
          // the buyer.
          const reusable =
            existing.status !== 'canceled' &&
            existing.status !== 'succeeded' &&
            existing.amount === toMinorUnits(row.finalAmount) &&
            existing.currency === CURRENCY;

          if (reusable) {
            return { kind: 'ok' as const, clientSecret: existing.client_secret };
          }

          // Not reusable, and it must not be left confirmable: the buyer's browser may still
          // hold its client secret, and a stale intent for the wrong amount is exactly what
          // this route exists to stop being paid. Cancelling is best-effort — an intent
          // already in a terminal state cannot be cancelled, and that is fine.
          if (existing.status !== 'canceled' && existing.status !== 'succeeded') {
            try {
              await stripe.paymentIntents.cancel(existing.id);
            } catch (err) {
              console.warn('[payments] could not cancel superseded intent', {
                paymentIntent: existing.id,
                error: err instanceof Error ? err.message : err,
              });
            }
          }
        }

        const auction = await dbTx.auction.findUnique({
          where: { id: row.auctionId },
          select: { title: true },
        });

        const paymentIntent = await stripe.paymentIntents.create(
          {
            // PKR is a two-decimal currency, so Stripe expects the amount in paisa. The
            // domain stores whole rupees, and this used to pass them through unconverted —
            // charging 1/100th of what the buyer was shown while recording the full amount as
            // revenue. Confirmed against Stripe's own error, which formatted the unconverted
            // integer back as "₨50.00" for a PKR 5,000 sale. See BV-001.
            amount: toMinorUnits(row.finalAmount),
            currency: CURRENCY,
            metadata: { transactionId: row.id, auctionId: row.auctionId, winnerId },
            description: `BidVault - ${auction?.title ?? 'auction'}`,
          },
          // Makes a retried or duplicated request return the *same* intent rather than a
          // second one. Belt and braces with the row lock above: the lock stops concurrent
          // callers, this stops a client retrying after a timeout.
          { idempotencyKey: `bidvault-intent-${row.id}` },
        );

        await dbTx.auctionTransaction.update({
          where: { id: row.id },
          data: {
            stripePaymentIntentId: paymentIntent.id,
            // Back to PENDING if this is a retry after a decline, and clear the stale reason
            // so it always describes the most recent attempt.
            status: 'PENDING',
            lastPaymentError: null,
          },
        });

        return { kind: 'ok' as const, clientSecret: paymentIntent.client_secret };
      });
    } catch (err) {
      // Stripe rejects an amount that converts below its minimum, which is exactly what the
      // unconverted-rupees bug produced for any sale under roughly PKR 15,000 — those never
      // got an intent at all. Surfacing the raw SDK message here would leak API internals
      // (BV-007); the transaction is left untouched and retryable.
      console.error('[payments] create-intent failed', {
        transactionId,
        error: err instanceof Error ? err.message : err,
      });
      fail(res, 'Could not start the payment. Please try again in a moment.', 502);
      return;
    }

    if (outcome.kind === 'fail') {
      fail(res, outcome.message, outcome.status);
      return;
    }
    ok(res, { clientSecret: outcome.clientSecret });
  }),
);

router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      fail(res, 'Webhook signature verification failed.', 400);
      return;
    }

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;

      const include = { winner: true, seller: true, auction: true } as const;

      let tx = await prisma.auctionTransaction.findUnique({
        where: { stripePaymentIntentId: paymentIntent.id },
        include,
      });

      // Second way in, when the stored id does not match.
      //
      // `metadata.transactionId` is set on every intent this service creates but was only
      // ever logged. It matters because the stored id is not a reliable key on its own: it
      // is overwritten whenever a superseded intent is replaced — which now happens
      // deliberately, when a stale intent carries the pre-BV-001 amount. A payment confirmed
      // against the older intent would otherwise arrive here, match nothing, and be
      // acknowledged with a 200. Money taken, transaction still PENDING, nothing but a log
      // line. That is the exact shape of the money-loss path BV-005 describes, reached from
      // the other end.
      //
      // The amount check below still runs, so resolving by metadata cannot short-circuit
      // verification — it only ensures the right row is the one being verified.
      if (!tx) {
        const fromMetadata = paymentIntent.metadata?.transactionId;
        if (fromMetadata) {
          tx = await prisma.auctionTransaction.findUnique({ where: { id: fromMetadata }, include });
          if (tx) {
            console.warn('[payments] intent resolved by metadata, not by stored id', {
              paymentIntent: paymentIntent.id,
              transactionId: tx.id,
              storedIntent: tx.stripePaymentIntentId,
            });
          }
        }
      }

      if (!tx) {
        // Genuinely nobody's: an intent from another environment sharing the webhook secret,
        // or one whose transaction has since been deleted. Logged rather than swallowed —
        // this is the last place a lost payment could still be noticed.
        console.error('[payments] succeeded event matched no transaction', {
          paymentIntent: paymentIntent.id,
          metadataTransactionId: paymentIntent.metadata?.transactionId,
        });
      } else if (tx.status === 'PENDING') {
        // What actually arrived, against what is owed. Without this the handler took the
        // event type as proof of settlement: Stripe reported success for the PKR 50 it had
        // been asked to collect, and this marked a PKR 5,000 debt paid. That is why BV-001
        // produced no error anywhere and had to be found by reading.
        const expected = toMinorUnits(tx.finalAmount);
        const received = paymentIntent.amount_received;

        if (received !== expected || paymentIntent.currency !== CURRENCY) {
          console.error('[payments] amount mismatch — NOT marking completed', {
            transactionId: tx.id,
            expected,
            received,
            currency: paymentIntent.currency,
          });
          // Acknowledged so Stripe stops retrying a delivery that is not the problem, but
          // deliberately left PENDING: an underpayment is not a settled debt.
          ok(res, { received: true });
          return;
        }

        // Conditional, so two concurrent deliveries of the same event cannot both pass the
        // status check and both send the emails. Only the update that actually moved the row
        // proceeds.
        const { count } = await prisma.auctionTransaction.updateMany({
          where: { id: tx.id, status: 'PENDING' },
          data: { status: 'COMPLETED', lastPaymentError: null },
        });

        if (count === 1) {
          // Not awaited: this runs inside the Stripe webhook, and a slow send could push the
          // handler past Stripe's timeout, causing it to retry an already-processed payment.
          dispatchEmail(sendPaymentCompletedEmail(
            { email: tx.winner.email, name: tx.winner.name },
            { email: tx.seller.email, name: tx.seller.name },
            { auctionTitle: tx.auction.title, finalAmount: Number(tx.finalAmount) },
          ), 'payment completed');
        }
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object;

      // Stays PENDING. Writing FAILED here is what made a single declined card permanent:
      // create-intent refused anything that was not PENDING, so there was no route back for
      // the winner and no admin action that could reopen it. The reason goes in its own
      // column instead, is shown to the buyer, and is cleared on the next attempt.
      //
      // Scoped to PENDING so a late-arriving failure for a superseded intent cannot disturb a
      // transaction that has since been paid.
      const reason =
        paymentIntent.last_payment_error?.message ??
        'The payment could not be completed. Please try a different card.';

      await prisma.auctionTransaction.updateMany({
        where: { stripePaymentIntentId: paymentIntent.id, status: 'PENDING' },
        data: { lastPaymentError: reason.slice(0, 500) },
      });
    }

    ok(res, { received: true });
  }),
);

export default router;
