import type { AuctionStatus, ListingStatus, Prisma, TransactionStatus } from '@prisma/client';

/**
 * What stage a seller's item is in, which tab it belongs to, and what the seller may do with it.
 *
 * One item is one Listing, with at most one Auction and at most one sale (Auction.listingId and
 * AuctionTransaction.auctionId are both unique), so each listing is exactly one row on the seller's
 * My Items screen. This file is the only place that decides the stage: deriveStage() reads the
 * facts of one item, STAGE_WHERE says the same thing as a database filter so a tab can be listed
 * without loading everything, and allowedActions() says what is offered. The screen renders the
 * answers and never re-derives a rule. The two halves are kept side by side so a change to one
 * is made next to the other, and tests/seller-items.test.ts checks they agree on real rows.
 */

export const SELLER_ITEM_TABS = ['action', 'review', 'live', 'sold', 'unsold', 'closed'] as const;
export type SellerItemTab = (typeof SELLER_ITEM_TABS)[number];

export const SELLER_ITEM_STAGES = [
  'UNDER_REVIEW',
  'REJECTED',
  'REMOVED',
  'LIVE',
  'AWAITING_PAYMENT',
  'NEEDS_SHIPPING',
  'SHIPPED',
  'DELIVERED',
  'DISPUTE_AWAITING_RESPONSE',
  'DISPUTED',
  'REFUNDED',
  'PAYMENT_DEFAULTED',
  'RELISTED',
  'ENDED_RESERVE_NOT_MET',
  'ENDED_NO_BIDS',
  'CANCELLED',
] as const;
export type SellerItemStage = (typeof SELLER_ITEM_STAGES)[number];

export const SELLER_ITEM_ACTIONS = [
  'WITHDRAW',
  'EDIT_RESUBMIT',
  'CANCEL_AUCTION',
  'MARK_SHIPPED',
  'RESPOND_TO_DISPUTE',
  'OFFER_NEXT_BIDDER',
  'RELIST',
  'LIST_AGAIN',
  'VIEW_INVOICE',
] as const;
export type SellerItemAction = (typeof SELLER_ITEM_ACTIONS)[number];

export interface ItemFacts {
  listingStatus: ListingStatus;
  auctionStatus?: AuctionStatus;
  /** null = no reserve was set, or the auction has not closed yet. */
  reserveMet?: boolean | null;
  bidCount?: number;
  /** Present when the item has a sale. */
  txnStatus?: TransactionStatus;
  /** The seller has sent their one response to the dispute on this sale. */
  disputeResponded: boolean;
  /** A new listing was created from this one's unpaid sale (Listing.relistedAs). */
  relisted: boolean;
  /** Somebody who has not already defaulted could be offered an unpaid sale (findNextBid). */
  hasNextBidder: boolean;
}

export const STAGE_TAB: Record<SellerItemStage, SellerItemTab> = {
  UNDER_REVIEW: 'review',
  REJECTED: 'closed',
  REMOVED: 'closed',
  LIVE: 'live',
  AWAITING_PAYMENT: 'sold',
  NEEDS_SHIPPING: 'action',
  SHIPPED: 'sold',
  DELIVERED: 'sold',
  DISPUTE_AWAITING_RESPONSE: 'action',
  DISPUTED: 'sold',
  REFUNDED: 'sold',
  PAYMENT_DEFAULTED: 'action',
  RELISTED: 'unsold',
  ENDED_RESERVE_NOT_MET: 'unsold',
  ENDED_NO_BIDS: 'unsold',
  CANCELLED: 'unsold',
};

/**
 * First match wins. A sale, once there is one, decides everything: a listing an admin removed
 * while its sale was paid still has to be shipped, so it stays in "Needs action".
 */
export function deriveStage(f: ItemFacts): SellerItemStage {
  switch (f.txnStatus) {
    case 'PENDING':
    case 'FAILED':
      return 'AWAITING_PAYMENT';
    case 'COMPLETED':
      return 'NEEDS_SHIPPING';
    case 'SHIPPED':
      return 'SHIPPED';
    case 'DELIVERED':
      return 'DELIVERED';
    case 'REFUNDED':
      return 'REFUNDED';
    case 'DISPUTED':
      return f.disputeResponded ? 'DISPUTED' : 'DISPUTE_AWAITING_RESPONSE';
    case 'VOIDED':
      if (f.relisted) return 'RELISTED';
      return f.listingStatus === 'REMOVED' ? 'REMOVED' : 'PAYMENT_DEFAULTED';
    case undefined:
      break;
  }

  switch (f.listingStatus) {
    case 'REJECTED':
      return 'REJECTED';
    case 'REMOVED':
      return 'REMOVED';
    case 'PENDING':
    case 'DRAFT':
      return 'UNDER_REVIEW';
    case 'APPROVED':
      break;
  }

  switch (f.auctionStatus) {
    case 'ACTIVE':
      return 'LIVE';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'CLOSED':
      // reserveMet is false for an auction that closed with no bids at all (nothing reached the
      // reserve), but "reserve not met" says a bid fell short, and the screen would show a top bid
      // nobody placed. No bids is its own, plainer outcome.
      return f.reserveMet === false && (f.bidCount ?? 0) > 0 ? 'ENDED_RESERVE_NOT_MET' : 'ENDED_NO_BIDS';
    case undefined:
      // Approved with no auction should not happen (approval creates both together); showing it
      // as still under review is the honest reading rather than an unexplained gap.
      return 'UNDER_REVIEW';
  }
}

/** Each existing write endpoint's own precondition, restated: the screen offers only what works. */
export function allowedActions(stage: SellerItemStage, f: ItemFacts): SellerItemAction[] {
  switch (stage) {
    case 'UNDER_REVIEW':
      // DELETE /listings/{id} refuses anything but PENDING.
      return f.listingStatus === 'PENDING' ? ['WITHDRAW'] : [];
    case 'REJECTED':
      return ['EDIT_RESUBMIT'];
    case 'LIVE':
      // The seller's own cancel path refuses an auction that has a bid.
      return (f.bidCount ?? 0) === 0 ? ['CANCEL_AUCTION'] : [];
    case 'NEEDS_SHIPPING':
      return ['MARK_SHIPPED', 'VIEW_INVOICE'];
    case 'DISPUTE_AWAITING_RESPONSE':
      return ['RESPOND_TO_DISPUTE', 'VIEW_INVOICE'];
    case 'PAYMENT_DEFAULTED':
      return f.hasNextBidder ? ['RELIST', 'OFFER_NEXT_BIDDER'] : ['RELIST'];
    case 'ENDED_RESERVE_NOT_MET':
    case 'ENDED_NO_BIDS':
      // Not a call to an endpoint: it fills the create-listing form from this item. Only for an
      // item that simply did not sell (eBay's Unsold list offers the same). Not for a removed one,
      // whose reason the seller should read first, and not for a cancelled one, because an admin's
      // cancellation cannot be told apart from the seller's own.
      return ['LIST_AGAIN'];
    case 'SHIPPED':
    case 'DELIVERED':
    case 'DISPUTED':
    case 'REFUNDED':
      return ['VIEW_INVOICE'];
    case 'REMOVED':
    case 'AWAITING_PAYMENT':
    case 'RELISTED':
    case 'CANCELLED':
      return [];
  }
}

// ---- the same rules as a database filter ---------------------------------------------------

type ListingWhere = Prisma.ListingWhereInput;

const sale = (statuses: TransactionStatus[], extra: Prisma.AuctionTransactionWhereInput = {}): ListingWhere => ({
  auction: { is: { transactions: { some: { status: { in: statuses }, ...extra } } } },
});

const noSale: ListingWhere = {
  OR: [{ auction: { is: null } }, { auction: { is: { transactions: { none: {} } } } }],
};

const disputeAnswered: Prisma.AuctionTransactionWhereInput = {
  dispute: { is: { sellerResponse: { not: null } } },
};

const relisted: ListingWhere = { relistedAs: { isNot: null } };
const notRelisted: ListingWhere = { relistedAs: { is: null } };

const noSaleAnd = (...parts: ListingWhere[]): ListingWhere => ({ AND: [noSale, ...parts] });
const approvedWithAuction = (auction: Prisma.AuctionWhereInput): ListingWhere => ({
  status: 'APPROVED',
  auction: { is: auction },
});

/** One fragment per stage, mutually exclusive and together exhaustive, mirroring deriveStage. */
const STAGE_WHERE: Record<SellerItemStage, ListingWhere> = {
  AWAITING_PAYMENT: sale(['PENDING', 'FAILED']),
  NEEDS_SHIPPING: sale(['COMPLETED']),
  SHIPPED: sale(['SHIPPED']),
  DELIVERED: sale(['DELIVERED']),
  REFUNDED: sale(['REFUNDED']),
  DISPUTE_AWAITING_RESPONSE: sale(['DISPUTED'], { NOT: disputeAnswered }),
  DISPUTED: sale(['DISPUTED'], disputeAnswered),
  RELISTED: { AND: [sale(['VOIDED']), relisted] },
  PAYMENT_DEFAULTED: { AND: [sale(['VOIDED']), notRelisted, { status: { not: 'REMOVED' } }] },
  REMOVED: {
    OR: [noSaleAnd({ status: 'REMOVED' }), { AND: [sale(['VOIDED']), notRelisted, { status: 'REMOVED' }] }],
  },
  REJECTED: noSaleAnd({ status: 'REJECTED' }),
  UNDER_REVIEW: noSaleAnd({
    OR: [{ status: { in: ['PENDING', 'DRAFT'] } }, { status: 'APPROVED', auction: { is: null } }],
  }),
  LIVE: noSaleAnd(approvedWithAuction({ status: 'ACTIVE' })),
  CANCELLED: noSaleAnd(approvedWithAuction({ status: 'CANCELLED' })),
  ENDED_RESERVE_NOT_MET: noSaleAnd(approvedWithAuction({ status: 'CLOSED', reserveMet: false, bidCount: { gt: 0 } })),
  // The complement of the line above, spelled out. Explicit null-or-true rather than NOT false: in
  // SQL, NOT (reserveMet = false) is unknown for a NULL, which would silently drop every auction
  // that ended with no reserve set. And a reserve auction with no bids (reserveMet false, bidCount 0)
  // belongs here, not above.
  ENDED_NO_BIDS: noSaleAnd(
    approvedWithAuction({ status: 'CLOSED', OR: [{ reserveMet: null }, { reserveMet: true }, { bidCount: { lte: 0 } }] }),
  ),
};

/** The listings that belong to a tab: the union of its stages' fragments. */
export function tabWhere(tab: SellerItemTab): ListingWhere {
  return { OR: SELLER_ITEM_STAGES.filter((s) => STAGE_TAB[s] === tab).map((s) => STAGE_WHERE[s]) };
}
