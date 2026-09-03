import type { Prisma, TransactionStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { clientOrigins } from '../config/env.js';
import { stripe, CURRENCY, toMinorUnits } from './stripe.service.js';
import { getPlatformSettings } from './settings.service.js';
import {
  dispatchEmail,
  sendItemShippedEmail,
  sendDeliveryConfirmedEmail,
  sendDisputeRaisedEmail,
  sendDisputeResolvedEmail,
} from './email.service.js';

/**
 * BV-047: the post-payment half of a sale, absent from the platform entirely before this
 * (LIFECYCLE-GAPS.md A4/C5/E6). A transaction moves COMPLETED -> SHIPPED -> DELIVERED (or
 * DISPUTED -> REFUNDED/DELIVERED) — see the TransactionStatus enum in schema.prisma for the
 * full state diagram.
 *
 * This module holds every state transition and every call to Stripe for it, because each one
 * has more than one caller that must behave identically: confirmDelivery() is reached from the
 * buyer's own route, the worker's timeout sweep, and an admin releasing a dispute; refund is
 * reached only from dispute resolution today but is kept separate from that orchestration for
 * the same reason. Routes and the worker stay thin callers, matching close-auction.ts's split
 * from auction-lifecycle.worker.ts.
 */

/**
 * Every status a transaction reaches once payment has actually succeeded, except REFUNDED —
 * the money went back, so it should no longer count as revenue. Before BV-047 every revenue
 * aggregate filtered for status = 'COMPLETED' alone; that status now means "paid, not yet
 * shipped" rather than "the whole sale", so anything reading it for a revenue figure needs
 * this list instead. Two admin.routes.ts queries are raw SQL and can't share this array
 * directly — kept in sync by hand, `status IN ('COMPLETED','SHIPPED','DELIVERED','DISPUTED')`.
 */
export const REVENUE_STATUSES: TransactionStatus[] = ['COMPLETED', 'SHIPPED', 'DELIVERED', 'DISPUTED'];

type LockedTransactionRow = {
  id: string;
  status: string;
  winnerId: string;
  sellerId: string;
  finalAmount: number;
  stripePaymentIntentId: string | null;
};

async function lockTransaction(
  tx: Prisma.TransactionClient,
  transactionId: string,
): Promise<LockedTransactionRow | undefined> {
  const [row] = await tx.$queryRaw<LockedTransactionRow[]>`
    SELECT id, status, "winnerId", "sellerId", "finalAmount", "stripePaymentIntentId"
    FROM "AuctionTransaction"
    WHERE id = ${transactionId}
    FOR UPDATE
  `;
  return row;
}

// ---------------------------------------------------------------------------
// Seller payout onboarding (C5)
// ---------------------------------------------------------------------------

export async function createConnectOnboardingLink(sellerId: string): Promise<{ url: string }> {
  const seller = await prisma.user.findUniqueOrThrow({ where: { id: sellerId } });

  let accountId = seller.stripeAccountId;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      email: seller.email,
      capabilities: { transfers: { requested: true } },
    });
    accountId = account.id;
    await prisma.user.update({ where: { id: sellerId }, data: { stripeAccountId: accountId } });
  }

  // Stripe-hosted: identity and bank details are collected on Stripe's own page, never by
  // this app. The base URL is whichever CLIENT_ORIGIN this deployment serves the frontend
  // from — the same value CORS already trusts, reused rather than adding a second env var.
  const base = clientOrigins[0];
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${base}/seller/profile?connect=refresh`,
    return_url: `${base}/seller/profile?connect=complete`,
    type: 'account_onboarding',
  });

  return { url: link.url };
}

export async function getConnectAccountStatus(
  sellerId: string,
): Promise<{ connected: boolean; onboardingComplete: boolean }> {
  const seller = await prisma.user.findUniqueOrThrow({ where: { id: sellerId } });
  if (!seller.stripeAccountId) return { connected: false, onboardingComplete: false };

  let account: Awaited<ReturnType<typeof stripe.accounts.retrieve>>;
  try {
    account = await stripe.accounts.retrieve(seller.stripeAccountId);
  } catch (err) {
    // A stored id Stripe can no longer resolve (revoked access, account deleted on Stripe's
    // side) must not 500 this route — it's read on every visit to Seller Profile and My
    // Sales. Reported as connected-but-unconfirmed rather than silently claiming the cached
    // value is still accurate.
    console.error('[fulfillment] could not retrieve Connect account status', {
      sellerId,
      stripeAccountId: seller.stripeAccountId,
      error: err instanceof Error ? err.message : err,
    });
    return { connected: true, onboardingComplete: false };
  }

  const onboardingComplete = Boolean(account.charges_enabled && account.payouts_enabled);

  // Cached on the row so "mark shipped" doesn't need a Stripe round trip on every call — only
  // this status check and the onboarding link do.
  if (onboardingComplete !== seller.stripeOnboardingComplete) {
    await prisma.user.update({ where: { id: sellerId }, data: { stripeOnboardingComplete: onboardingComplete } });
  }

  return { connected: true, onboardingComplete };
}

// ---------------------------------------------------------------------------
// Ship
// ---------------------------------------------------------------------------

export type MarkShippedResult =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'wrong-state' }
  | { kind: 'no-address' }
  | { kind: 'payout-not-ready' };

export async function markShipped(transactionId: string, sellerId: string): Promise<MarkShippedResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const row = await lockTransaction(tx, transactionId);
    if (!row) return { kind: 'not-found' as const };
    if (row.sellerId !== sellerId) return { kind: 'forbidden' as const };
    if (row.status !== 'COMPLETED') return { kind: 'wrong-state' as const };

    const [full, seller] = await Promise.all([
      tx.auctionTransaction.findUniqueOrThrow({
        where: { id: row.id },
        select: {
          deliveryAddress: true,
          auction: { select: { title: true } },
          winner: { select: { email: true, name: true } },
        },
      }),
      tx.user.findUniqueOrThrow({ where: { id: sellerId }, select: { stripeOnboardingComplete: true } }),
    ]);
    if (!full.deliveryAddress) return { kind: 'no-address' as const };
    if (!seller.stripeOnboardingComplete) return { kind: 'payout-not-ready' as const };

    await tx.auctionTransaction.update({
      where: { id: row.id },
      data: { status: 'SHIPPED', shippedAt: new Date() },
    });

    return { kind: 'ok' as const, auctionTitle: full.auction.title, buyer: full.winner };
  });

  if (outcome.kind === 'ok') {
    const { reviewTimeoutHours } = await getPlatformSettings();
    dispatchEmail(
      sendItemShippedEmail(outcome.buyer, { auctionTitle: outcome.auctionTitle, reviewTimeoutHours }),
      `item-shipped (${transactionId})`,
    );
  }

  return outcome.kind === 'ok' ? { kind: 'ok' } : outcome;
}

// ---------------------------------------------------------------------------
// Confirm delivery -> payout (used by the buyer's route, the timeout sweep, and an admin
// releasing a dispute in the seller's favour)
// ---------------------------------------------------------------------------

export type ConfirmDeliveryResult =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'wrong-state' };

export async function confirmDelivery(
  transactionId: string,
  opts: { requireWinnerId?: string; auto?: boolean; fromDisputed?: boolean } = {},
): Promise<ConfirmDeliveryResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const row = await lockTransaction(tx, transactionId);
    if (!row) return { kind: 'not-found' as const };
    if (opts.requireWinnerId && row.winnerId !== opts.requireWinnerId) return { kind: 'forbidden' as const };
    // Every caller reaches this from SHIPPED except an admin releasing a dispute in the
    // seller's favour, which reaches it from DISPUTED — resolveDispute() sets fromDisputed so
    // the two paths cannot be confused with each other.
    const expectedState = opts.fromDisputed ? 'DISPUTED' : 'SHIPPED';
    if (row.status !== expectedState) return { kind: 'wrong-state' as const };

    const full = await tx.auctionTransaction.findUniqueOrThrow({
      where: { id: row.id },
      select: { auction: { select: { title: true } }, seller: true },
    });

    await tx.auctionTransaction.update({ where: { id: row.id }, data: { status: 'DELIVERED' } });

    return {
      kind: 'ok' as const,
      finalAmount: row.finalAmount,
      auctionTitle: full.auction.title,
      seller: full.seller,
    };
  });

  if (outcome.kind !== 'ok') return { kind: outcome.kind };

  // Outside the transaction, same reasoning as close-auction.ts's dispatchEmail: neither the
  // Stripe call nor the email should hold the row lock, and a retried job would find the row
  // already DELIVERED and never reach here a second time (BV-012's pattern).
  if (outcome.seller.stripeAccountId) {
    try {
      await stripe.transfers.create({
        amount: toMinorUnits(outcome.finalAmount),
        currency: CURRENCY,
        destination: outcome.seller.stripeAccountId,
        transfer_group: transactionId,
      });
    } catch (err) {
      // The buyer-facing fact (item received) is true regardless of whether Stripe's side
      // succeeds, so the state transition above is not rolled back for this — but a failed
      // transfer means the seller is owed money with nothing paid, which needs a human, not a
      // silent retry. Logged loudly, matching the existing amount-mismatch webhook case.
      console.error('[fulfillment] transfer failed after delivery confirmed', {
        transactionId,
        sellerId: outcome.seller.id,
        error: err instanceof Error ? err.message : err,
      });
    }
  } else {
    console.error('[fulfillment] delivery confirmed with no seller Stripe account on file', { transactionId });
  }

  dispatchEmail(
    sendDeliveryConfirmedEmail(
      { email: outcome.seller.email, name: outcome.seller.name },
      { auctionTitle: outcome.auctionTitle, finalAmount: outcome.finalAmount, auto: opts.auto === true },
    ),
    `delivery-confirmed (${transactionId})`,
  );

  return { kind: 'ok' };
}

// ---------------------------------------------------------------------------
// Dispute
// ---------------------------------------------------------------------------

export type RaiseDisputeResult =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'wrong-state' };

export async function raiseDispute(
  transactionId: string,
  buyerId: string,
  reason: string,
): Promise<RaiseDisputeResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const row = await lockTransaction(tx, transactionId);
    if (!row) return { kind: 'not-found' as const };
    if (row.winnerId !== buyerId) return { kind: 'forbidden' as const };
    if (row.status !== 'SHIPPED') return { kind: 'wrong-state' as const };

    const full = await tx.auctionTransaction.findUniqueOrThrow({
      where: { id: row.id },
      select: { auction: { select: { title: true } }, seller: { select: { email: true, name: true } } },
    });

    await tx.auctionTransaction.update({ where: { id: row.id }, data: { status: 'DISPUTED' } });
    await tx.dispute.create({
      data: { transactionId: row.id, raisedByUserId: buyerId, reason },
    });

    return { kind: 'ok' as const, auctionTitle: full.auction.title, seller: full.seller };
  });

  if (outcome.kind === 'ok') {
    dispatchEmail(
      sendDisputeRaisedEmail(outcome.seller, { auctionTitle: outcome.auctionTitle, reason }),
      `dispute-raised (${transactionId})`,
    );
    return { kind: 'ok' };
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Admin dispute resolution
// ---------------------------------------------------------------------------

export type ResolveDisputeResult =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'not-open' };

export async function resolveDispute(
  disputeId: string,
  adminUserId: string,
  resolution: 'REFUND' | 'RELEASE',
  note: string,
): Promise<ResolveDisputeResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    // Locked the same way every other admin decision on a financial row is (void-transaction,
    // create-intent): two admins resolving the same dispute at once must not both pass the
    // OPEN check before either write commits.
    const [locked] = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM "Dispute" WHERE id = ${disputeId} FOR UPDATE
    `;
    if (!locked) return { kind: 'not-found' as const };
    if (locked.status !== 'OPEN') return { kind: 'not-open' as const };

    const dispute = await tx.dispute.findUniqueOrThrow({
      where: { id: disputeId },
      include: {
        transaction: {
          include: {
            auction: { select: { title: true } },
            winner: { select: { email: true, name: true } },
            seller: { select: { email: true, name: true } },
          },
        },
      },
    });

    await tx.dispute.update({
      where: { id: dispute.id },
      data: {
        status: resolution === 'REFUND' ? 'RESOLVED_REFUNDED' : 'RESOLVED_RELEASED',
        resolvedByUserId: adminUserId,
        resolutionNote: note,
        resolvedAt: new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: resolution === 'REFUND' ? 'DISPUTE_RESOLVED_REFUNDED' : 'DISPUTE_RESOLVED_RELEASED',
        entityType: 'Dispute',
        entityId: dispute.id,
        metadata: { transactionId: dispute.transactionId, note },
      },
    });

    if (resolution === 'REFUND') {
      // REFUNDED here, not left to confirmDelivery/transfer — a dispute is only reachable
      // from SHIPPED, so no transfer has ever fired for this transaction. A plain refund
      // against the original charge is the whole cost; there is nothing to reverse.
      await tx.auctionTransaction.update({ where: { id: dispute.transactionId }, data: { status: 'REFUNDED' } });
    }

    return {
      kind: 'ok' as const,
      transactionId: dispute.transactionId,
      stripePaymentIntentId: dispute.transaction.stripePaymentIntentId,
      auctionTitle: dispute.transaction.auction.title,
      buyer: dispute.transaction.winner,
      seller: dispute.transaction.seller,
    };
  });

  if (outcome.kind !== 'ok') return outcome;

  if (resolution === 'REFUND') {
    if (outcome.stripePaymentIntentId) {
      try {
        await stripe.refunds.create({ payment_intent: outcome.stripePaymentIntentId });
      } catch (err) {
        console.error('[fulfillment] refund failed after dispute resolved REFUNDED', {
          transactionId: outcome.transactionId,
          error: err instanceof Error ? err.message : err,
        });
      }
    }
    dispatchEmail(
      sendDisputeResolvedEmail(outcome.buyer, outcome.seller, {
        auctionTitle: outcome.auctionTitle,
        resolution: 'REFUNDED',
        note,
      }),
      `dispute-resolved-refunded (${outcome.transactionId})`,
    );
    return { kind: 'ok' };
  }

  // RELEASE: reuse confirmDelivery for the exact same SHIPPED-was-never-true-here transition
  // it does for everyone else — the dispute row is already resolved above, so this only needs
  // to move the transaction itself and fire the transfer.
  await confirmDelivery(outcome.transactionId, { fromDisputed: true });
  dispatchEmail(
    sendDisputeResolvedEmail(outcome.buyer, outcome.seller, {
      auctionTitle: outcome.auctionTitle,
      resolution: 'RELEASED',
      note,
    }),
    `dispute-resolved-released (${outcome.transactionId})`,
  );
  return { kind: 'ok' };
}

// ---------------------------------------------------------------------------
// Timeout sweep (BV-040): SHIPPED rows whose reviewTimeoutHours has elapsed with no open
// dispute auto-confirm, same as if the buyer had clicked confirm-receipt themselves.
// ---------------------------------------------------------------------------

export async function findTimedOutShipments(): Promise<string[]> {
  const { reviewTimeoutHours } = await getPlatformSettings();
  const cutoff = new Date(Date.now() - reviewTimeoutHours * 60 * 60 * 1000);

  const rows = await prisma.auctionTransaction.findMany({
    where: { status: 'SHIPPED', shippedAt: { lt: cutoff } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
