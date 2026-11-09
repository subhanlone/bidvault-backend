import type { ListingStatus, Prisma, TransactionStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getPlatformSettings } from './settings.service.js';

/**
 * B5 PR 3a: the monthly selling limit and the seller's standing (docs/B5-SELLER-ACCOUNT-RESEARCH.md
 * sections 3.3 and 9, decided by the user on 2026-10-19 and 2026-11-09).
 *
 * - A seller with fewer than `sellerGraduationSales` completed (DELIVERED) sales is NEW and may list
 *   at most `newSellerMonthlyItems` items worth `newSellerMonthlyValue` of starting price per
 *   calendar month in Asia/Karachi.
 * - Past that they are ESTABLISHED, with no limit, while their record stays clean. They are RESTRICTED
 *   (the limit is back) when, among their last 12 months of paid sales, at least 2 ended in a refund,
 *   with at least 2 different buyers, and the refund rate is above 10%. Every refunded paid sale is a
 *   defect, whatever led to the refund.
 * - An admin's per-person override replaces the platform numbers, whatever the standing.
 *
 * Everything is computed from the data when needed: no stored flag, no monthly job.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** Pakistan Standard Time is UTC+5 all year (no daylight saving). */
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const NEAR_LIMIT_SHARE = 0.8;
const DEFECT_MIN_REFUNDS = 2;
const DEFECT_MIN_BUYERS = 2;
const DEFECT_MIN_RATE = 0.1;

/** Listings that use the month: anything submitted that was not rejected or withdrawn (deleted). */
const COUNTED_LISTING: ListingStatus[] = ['PENDING', 'APPROVED', 'REMOVED'];
/** A sale the buyer paid for, whatever happened after. */
const PAID_SALE: TransactionStatus[] = ['COMPLETED', 'SHIPPED', 'DELIVERED', 'DISPUTED', 'REFUNDED'];

/** Midnight on the 1st of the Karachi calendar month that `at` falls in, as a UTC instant. */
export function karachiMonthStart(at: Date): Date {
  const local = new Date(at.getTime() + KARACHI_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - KARACHI_OFFSET_MS);
}

/** When the month that `at` falls in ends, and the limit starts again. */
export function karachiNextMonthStart(at: Date): Date {
  const local = new Date(at.getTime() + KARACHI_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - KARACHI_OFFSET_MS);
}

const resetDay = (at: Date) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'Asia/Karachi' }).format(at);
const pkr = (n: number) => `PKR ${n.toLocaleString('en-US')}`;

export type SellerStandingName = 'NEW' | 'ESTABLISHED' | 'RESTRICTED';

export interface SellerStanding {
  standing: SellerStandingName;
  /** True while the platform's monthly limit applies (NEW or RESTRICTED). */
  capped: boolean;
  completedSales: number;
  salesToGraduate: number;
  /** The last 12 months: paid sales, those refunded, and how many different buyers were refunded. */
  paidSales: number;
  refunds: number;
  refundBuyers: number;
}

export async function sellerStanding(db: Db, sellerId: string, now = new Date()): Promise<SellerStanding> {
  const { sellerGraduationSales } = await getPlatformSettings();
  const since = new Date(now.getTime() - YEAR_MS);
  // A sale paid before paidAt existed has none; its creation time stands in for it.
  const lastYear: Prisma.AuctionTransactionWhereInput = {
    sellerId,
    OR: [{ paidAt: { gte: since } }, { paidAt: null, createdAt: { gte: since } }],
  };

  const completedSales = await db.auctionTransaction.count({ where: { sellerId, status: 'DELIVERED' } });
  const paidSales = await db.auctionTransaction.count({ where: { ...lastYear, status: { in: PAID_SALE } } });
  const refunded = await db.auctionTransaction.findMany({
    where: { ...lastYear, status: 'REFUNDED' },
    select: { winnerId: true },
  });
  const refunds = refunded.length;
  const refundBuyers = new Set(refunded.map((r) => r.winnerId)).size;

  const graduated = completedSales >= sellerGraduationSales;
  const slipped =
    refunds >= DEFECT_MIN_REFUNDS && refundBuyers >= DEFECT_MIN_BUYERS && paidSales > 0 && refunds / paidSales > DEFECT_MIN_RATE;
  const standing: SellerStandingName = !graduated ? 'NEW' : slipped ? 'RESTRICTED' : 'ESTABLISHED';

  return {
    standing,
    capped: standing !== 'ESTABLISHED',
    completedSales,
    salesToGraduate: Math.max(0, sellerGraduationSales - completedSales),
    paidSales,
    refunds,
    refundBuyers,
  };
}

export interface SellerLimits extends SellerStanding {
  items: { used: number; limit: number | null };
  value: { used: number; limit: number | null };
  resetsAt: Date;
}

/** Items and starting-price value the seller has used this month. */
async function monthlyUsage(db: Db, sellerId: string, now: Date) {
  const start = karachiMonthStart(now);
  const thisMonth = await db.listing.aggregate({
    where: { sellerId, submittedAt: { gte: start }, status: { in: COUNTED_LISTING } },
    _count: { _all: true },
    _sum: { startPrice: true },
  });
  // As eBay: a listing from an earlier month that is still live uses this month too.
  const carried = await db.listing.aggregate({
    where: { sellerId, submittedAt: { lt: start }, status: 'APPROVED', auction: { status: 'ACTIVE' } },
    _count: { _all: true },
    _sum: { startPrice: true },
  });
  return {
    items: thisMonth._count._all + carried._count._all,
    value: (thisMonth._sum.startPrice ?? 0) + (carried._sum.startPrice ?? 0),
  };
}

export async function sellerLimits(db: Db, sellerId: string, now = new Date()): Promise<SellerLimits> {
  const settings = await getPlatformSettings();
  const [standing, usage, user] = [
    await sellerStanding(db, sellerId, now),
    await monthlyUsage(db, sellerId, now),
    await db.user.findUniqueOrThrow({
      where: { id: sellerId },
      select: { sellerLimitOverrideItems: true, sellerLimitOverrideValue: true },
    }),
  ];
  return {
    ...standing,
    items: {
      used: usage.items,
      limit: user.sellerLimitOverrideItems ?? (standing.capped ? settings.newSellerMonthlyItems : null),
    },
    value: {
      used: usage.value,
      limit: user.sellerLimitOverrideValue ?? (standing.capped ? settings.newSellerMonthlyValue : null),
    },
    resetsAt: karachiNextMonthStart(now),
  };
}

export type LimitCheck = { ok: true } | { ok: false; message: string };

/**
 * Whether one more listing at `startPrice` fits this month. The caller holds the seller's row lock
 * (lockSellerForListing), so two submissions at once cannot both pass with one item left.
 */
export async function checkMonthlyLimit(tx: Prisma.TransactionClient, sellerId: string, startPrice: number, now = new Date()): Promise<LimitCheck> {
  const limits = await sellerLimits(tx, sellerId, now);
  const resets = `It resets on ${resetDay(limits.resetsAt)}.`;
  if (limits.items.limit !== null && limits.items.used + 1 > limits.items.limit) {
    return {
      ok: false,
      message: `You have reached this month's limit of ${limits.items.limit} items. ${resets}`,
    };
  }
  if (limits.value.limit !== null && limits.value.used + startPrice > limits.value.limit) {
    return {
      ok: false,
      message:
        `This listing would take this month's listings to ${pkr(limits.value.used + startPrice)}, over your limit of ` +
        `${pkr(limits.value.limit)}. ${resets}`,
    };
  }
  return { ok: true };
}

/** Serialises listing submissions per seller for the limit check. */
export async function lockSellerForListing(tx: Prisma.TransactionClient, sellerId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${sellerId} FOR UPDATE`;
}

/**
 * After a listing is added: one in-app notice per month, the first time either figure reaches 80%
 * (eBay messages a seller near their limit). Runs in the submitting transaction, under the lock.
 */
export async function noteNearLimit(tx: Prisma.TransactionClient, sellerId: string, now = new Date()): Promise<void> {
  const limits = await sellerLimits(tx, sellerId, now);
  const near = (used: number, limit: number | null) => limit !== null && used >= limit * NEAR_LIMIT_SHARE;
  if (!near(limits.items.used, limits.items.limit) && !near(limits.value.used, limits.value.limit)) return;

  const already = await tx.notification.count({
    where: { userId: sellerId, type: 'SELLER_LIMIT_NEAR', createdAt: { gte: karachiMonthStart(now) } },
  });
  if (already > 0) return;

  const parts: string[] = [];
  if (limits.items.limit !== null) parts.push(`${limits.items.used} of ${limits.items.limit} items`);
  if (limits.value.limit !== null) parts.push(`${pkr(limits.value.used)} of ${pkr(limits.value.limit)}`);
  await tx.notification.create({
    data: {
      userId: sellerId,
      type: 'SELLER_LIMIT_NEAR',
      title: 'You are close to your monthly limit',
      message: `You have used ${parts.join(' and ')} this month. Your limit resets on ${resetDay(limits.resetsAt)}.`,
    },
  });
}

/**
 * Called by the paths that end a sale (delivery, every kind of refund) with the standing read before
 * the change, inside the same transaction: tells the seller when the change lifted the limit or
 * brought it back. A standing that changes only because time passed (refunds ageing past 12 months)
 * is not announced; the seller sees it on their meter.
 */
export async function noteStandingChange(tx: Prisma.TransactionClient, sellerId: string, before: SellerStanding): Promise<void> {
  const after = await sellerStanding(tx, sellerId);
  if (before.capped && !after.capped) {
    await tx.notification.create({
      data: {
        userId: sellerId,
        type: 'SELLER_GRADUATED',
        title: 'You are now an established seller',
        message: 'You have no monthly selling limit any more. Keep your sales clean to keep it that way.',
      },
    });
  } else if (!before.capped && after.standing === 'RESTRICTED') {
    const settings = await getPlatformSettings();
    await tx.notification.create({
      data: {
        userId: sellerId,
        type: 'SELLER_LIMIT_RETURNED',
        title: 'Your monthly selling limit is back',
        message:
          `${after.refunds} of your ${after.paidSales} paid sales in the last 12 months were refunded, to ` +
          `${after.refundBuyers} different buyers. Until that is ${Math.round(DEFECT_MIN_RATE * 100)}% or less, you can list ` +
          `${settings.newSellerMonthlyItems} items worth up to ${pkr(settings.newSellerMonthlyValue)} a month.`,
      },
    });
  }
}

/** The welcome an account gets when it becomes a seller: the limit it starts with. */
export async function sellerWelcomeMessage(): Promise<string> {
  const s = await getPlatformSettings();
  return (
    `You can now sell on BidVault. As a new seller you can list up to ${s.newSellerMonthlyItems} items, worth up to ` +
    `${pkr(s.newSellerMonthlyValue)} in starting prices, each month. The limit lifts after ` +
    `${s.sellerGraduationSales} completed sales.`
  );
}
