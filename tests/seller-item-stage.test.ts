/**
 * The one place that decides what stage a seller's item is in, which tab it belongs to, and what
 * the seller may do with it. The screen renders these answers and never re-derives them.
 */
import { describe, expect, it } from 'vitest';
import {
  SELLER_ITEM_STAGES,
  SELLER_ITEM_TABS,
  STAGE_TAB,
  allowedActions,
  deriveStage,
  type ItemFacts,
  type SellerItemStage,
  type SellerItemTab,
} from '../src/modules/seller-items/seller-item-stage.js';

const facts = (overrides: Partial<ItemFacts> = {}): ItemFacts => ({
  listingStatus: 'APPROVED',
  disputeResponded: false,
  relisted: false,
  hasNextBidder: false,
  ...overrides,
});

const CASES: Array<[string, SellerItemStage, SellerItemTab, ItemFacts]> = [
  ['pending listing', 'UNDER_REVIEW', 'review', facts({ listingStatus: 'PENDING' })],
  ['draft listing', 'UNDER_REVIEW', 'review', facts({ listingStatus: 'DRAFT' })],
  ['approved with no auction yet', 'UNDER_REVIEW', 'review', facts()],
  ['rejected listing', 'REJECTED', 'closed', facts({ listingStatus: 'REJECTED' })],
  ['removed listing', 'REMOVED', 'closed', facts({ listingStatus: 'REMOVED', auctionStatus: 'CANCELLED' })],
  ['live auction', 'LIVE', 'live', facts({ auctionStatus: 'ACTIVE', bidCount: 3 })],
  ['unpaid sale', 'AWAITING_PAYMENT', 'sold', facts({ auctionStatus: 'CLOSED', txnStatus: 'PENDING' })],
  ['failed payment', 'AWAITING_PAYMENT', 'sold', facts({ auctionStatus: 'CLOSED', txnStatus: 'FAILED' })],
  ['paid, not shipped', 'NEEDS_SHIPPING', 'action', facts({ auctionStatus: 'CLOSED', txnStatus: 'COMPLETED' })],
  ['shipped', 'SHIPPED', 'sold', facts({ auctionStatus: 'CLOSED', txnStatus: 'SHIPPED' })],
  ['delivered', 'DELIVERED', 'sold', facts({ auctionStatus: 'CLOSED', txnStatus: 'DELIVERED' })],
  ['refunded', 'REFUNDED', 'sold', facts({ auctionStatus: 'CLOSED', txnStatus: 'REFUNDED' })],
  ['dispute waiting for the seller', 'DISPUTE_AWAITING_RESPONSE', 'action', facts({ auctionStatus: 'CLOSED', txnStatus: 'DISPUTED' })],
  ['dispute the seller answered', 'DISPUTED', 'sold', facts({ auctionStatus: 'CLOSED', txnStatus: 'DISPUTED', disputeResponded: true })],
  ['buyer never paid', 'PAYMENT_DEFAULTED', 'action', facts({ auctionStatus: 'CLOSED', txnStatus: 'VOIDED' })],
  ['buyer never paid, then relisted', 'RELISTED', 'unsold', facts({ auctionStatus: 'CLOSED', txnStatus: 'VOIDED', relisted: true })],
  ['buyer never paid, then removed', 'REMOVED', 'closed', facts({ listingStatus: 'REMOVED', auctionStatus: 'CLOSED', txnStatus: 'VOIDED' })],
  ['reserve not met', 'ENDED_RESERVE_NOT_MET', 'unsold', facts({ auctionStatus: 'CLOSED', reserveMet: false, bidCount: 2 })],
  ['no bids', 'ENDED_NO_BIDS', 'unsold', facts({ auctionStatus: 'CLOSED', reserveMet: null, bidCount: 0 })],
  ['cancelled auction', 'CANCELLED', 'unsold', facts({ auctionStatus: 'CANCELLED' })],
];

describe('deriveStage and STAGE_TAB', () => {
  it.each(CASES)('%s', (_name, stage, tab, f) => {
    expect(deriveStage(f)).toBe(stage);
    expect(STAGE_TAB[stage]).toBe(tab);
  });

  it('REMOVED listing with a COMPLETED sale stays in action', () => {
    const stage = deriveStage(facts({ listingStatus: 'REMOVED', auctionStatus: 'CLOSED', txnStatus: 'COMPLETED' }));
    expect(stage).toBe('NEEDS_SHIPPING');
    expect(STAGE_TAB[stage]).toBe('action');
  });

  it('relisted VOIDED sale is RELISTED not PAYMENT_DEFAULTED', () => {
    const f = facts({ auctionStatus: 'CLOSED', txnStatus: 'VOIDED' });
    expect(deriveStage(f)).toBe('PAYMENT_DEFAULTED');
    expect(deriveStage({ ...f, relisted: true })).toBe('RELISTED');
  });

  it('a DISPUTED sale moves from action to sold once the seller responds', () => {
    const f = facts({ auctionStatus: 'CLOSED', txnStatus: 'DISPUTED' });
    expect(STAGE_TAB[deriveStage(f)]).toBe('action');
    expect(STAGE_TAB[deriveStage({ ...f, disputeResponded: true })]).toBe('sold');
  });

  it('every stage maps to exactly one tab, and every tab has a stage', () => {
    expect(Object.keys(STAGE_TAB).sort()).toEqual([...SELLER_ITEM_STAGES].sort());
    for (const stage of SELLER_ITEM_STAGES) expect(SELLER_ITEM_TABS).toContain(STAGE_TAB[stage]);
    for (const tab of SELLER_ITEM_TABS) {
      expect(SELLER_ITEM_STAGES.some((s) => STAGE_TAB[s] === tab)).toBe(true);
    }
  });
});

describe('allowedActions', () => {
  it('a pending listing can be withdrawn, a draft or approved-without-auction one cannot', () => {
    expect(allowedActions('UNDER_REVIEW', facts({ listingStatus: 'PENDING' }))).toEqual(['WITHDRAW']);
    expect(allowedActions('UNDER_REVIEW', facts({ listingStatus: 'DRAFT' }))).toEqual([]);
    expect(allowedActions('UNDER_REVIEW', facts())).toEqual([]);
  });

  it('a rejected listing can be edited and resubmitted', () => {
    expect(allowedActions('REJECTED', facts({ listingStatus: 'REJECTED' }))).toEqual(['EDIT_RESUBMIT']);
  });

  it('CANCEL_AUCTION is absent once a bid exists', () => {
    expect(allowedActions('LIVE', facts({ auctionStatus: 'ACTIVE', bidCount: 0 }))).toEqual(['CANCEL_AUCTION']);
    expect(allowedActions('LIVE', facts({ auctionStatus: 'ACTIVE', bidCount: 1 }))).toEqual([]);
  });

  it('a paid sale can be shipped and its invoice viewed', () => {
    expect(allowedActions('NEEDS_SHIPPING', facts({ txnStatus: 'COMPLETED' }))).toEqual(['MARK_SHIPPED', 'VIEW_INVOICE']);
  });

  it('a dispute waiting for the seller offers the response and the invoice', () => {
    expect(allowedActions('DISPUTE_AWAITING_RESPONSE', facts({ txnStatus: 'DISPUTED' }))).toEqual([
      'RESPOND_TO_DISPUTE',
      'VIEW_INVOICE',
    ]);
    expect(allowedActions('DISPUTED', facts({ txnStatus: 'DISPUTED', disputeResponded: true }))).toEqual(['VIEW_INVOICE']);
  });

  it('OFFER_NEXT_BIDDER is absent without a next bidder', () => {
    const f = facts({ auctionStatus: 'CLOSED', txnStatus: 'VOIDED' });
    expect(allowedActions('PAYMENT_DEFAULTED', f)).toEqual(['RELIST']);
    expect(allowedActions('PAYMENT_DEFAULTED', { ...f, hasNextBidder: true })).toEqual(['RELIST', 'OFFER_NEXT_BIDDER']);
  });

  it('LIST_AGAIN only on the two ended stages', () => {
    for (const stage of SELLER_ITEM_STAGES) {
      const has = allowedActions(stage, facts({ auctionStatus: 'CLOSED' })).includes('LIST_AGAIN');
      expect(has).toBe(stage === 'ENDED_RESERVE_NOT_MET' || stage === 'ENDED_NO_BIDS');
    }
  });

  it('a removed, relisted or cancelled item offers nothing', () => {
    expect(allowedActions('REMOVED', facts({ listingStatus: 'REMOVED' }))).toEqual([]);
    expect(allowedActions('RELISTED', facts({ txnStatus: 'VOIDED', relisted: true }))).toEqual([]);
    expect(allowedActions('CANCELLED', facts({ auctionStatus: 'CANCELLED' }))).toEqual([]);
  });

  it('the paid stages after shipping offer only the invoice', () => {
    for (const stage of ['SHIPPED', 'DELIVERED', 'REFUNDED'] as const) {
      expect(allowedActions(stage, facts({ txnStatus: 'SHIPPED' }))).toEqual(['VIEW_INVOICE']);
    }
  });
});
