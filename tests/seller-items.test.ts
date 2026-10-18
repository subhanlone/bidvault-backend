/**
 * GET /seller/items and /seller/items/summary: the seller's whole inventory as one list, one row
 * per item whatever stage it is in, split into six tabs. The rules themselves are unit-tested in
 * seller-item-stage.test.ts; this file checks that the database filter agrees with them on real
 * rows (the six tabs must partition the seller's items exactly), plus ordering, paging, search,
 * ownership, and what a row carries.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { AuctionStatus, ListingStatus, TransactionStatus } from '@prisma/client';
import { resData, resError, type Paginated } from './helpers/api.js';

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: vi.fn(() => Promise.resolve({ data: { id: 'email_test' }, error: null })) };
  },
}));

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { takeViolations } = await import('../src/middleware/response-contract.js');
const { seedWorld } = await import('./helpers/world.js');
const { signAccessToken } = await import('../src/utils/jwt.js');
const { SELLER_ITEM_STAGES, SELLER_ITEM_TABS, STAGE_TAB } = await import(
  '../src/modules/seller-items/seller-item-stage.js'
);

type World = Awaited<ReturnType<typeof seedWorld>>;
type Stage = (typeof SELLER_ITEM_STAGES)[number];
type Tab = (typeof SELLER_ITEM_TABS)[number];

interface Row {
  itemId: string;
  listingCode: string;
  title: string;
  tab: Tab;
  stage: Stage;
  actions: string[];
  listing: {
    description: string;
    startPrice: number;
    reservePrice?: number;
    rejectionReason?: string;
    submittedAt: string;
  };
  auction?: { auctionId: string; status: string; bidCount: number; watcherCount: number; endTime: string };
  sale?: {
    transactionId: string;
    status: string;
    buyerName: string;
    paidAt?: string;
    disputeReason?: string;
    disputeResponseDueAt?: string;
    disputeSellerResponse?: string;
    nextBidderOffer: number | null;
  };
  relistedAs?: { listingId: string; listingCode: string };
}

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let w: World;
let seq = 0;
let thirdBuyerId: string;

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  seq = 0;
  w = await seedWorld();
  const third = await prisma.user.create({
    data: { name: 'Third Buyer', email: 'third-buyer@test.local', passwordHash: 'x', role: 'BUYER', isEmailVerified: true },
  });
  thirdBuyerId = third.id;
});

afterEach(() => {
  takeViolations();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

// ---- fixtures -------------------------------------------------------------------------------

interface Spec {
  listing: ListingStatus;
  auction?: { status: AuctionStatus; reserveMet?: boolean | null; bidCount?: number; open?: boolean };
  tx?: TransactionStatus;
  dispute?: 'open' | 'answered';
}

/** One real-looking item per stage, built the way the app builds them. */
const SPEC: Record<Stage, Spec> = {
  UNDER_REVIEW: { listing: 'PENDING' },
  REJECTED: { listing: 'REJECTED' },
  REMOVED: { listing: 'REMOVED', auction: { status: 'CANCELLED' } },
  LIVE: { listing: 'APPROVED', auction: { status: 'ACTIVE', open: true } },
  AWAITING_PAYMENT: { listing: 'APPROVED', auction: { status: 'CLOSED', reserveMet: true, bidCount: 1 }, tx: 'PENDING' },
  NEEDS_SHIPPING: { listing: 'APPROVED', auction: { status: 'CLOSED', reserveMet: true, bidCount: 1 }, tx: 'COMPLETED' },
  SHIPPED: { listing: 'APPROVED', auction: { status: 'CLOSED', reserveMet: true, bidCount: 1 }, tx: 'SHIPPED' },
  DELIVERED: { listing: 'APPROVED', auction: { status: 'CLOSED', reserveMet: true, bidCount: 1 }, tx: 'DELIVERED' },
  DISPUTE_AWAITING_RESPONSE: {
    listing: 'APPROVED', auction: { status: 'CLOSED', reserveMet: true, bidCount: 1 }, tx: 'DISPUTED', dispute: 'open',
  },
  DISPUTED: {
    listing: 'APPROVED', auction: { status: 'CLOSED', reserveMet: true, bidCount: 1 }, tx: 'DISPUTED', dispute: 'answered',
  },
  REFUNDED: { listing: 'APPROVED', auction: { status: 'CLOSED', reserveMet: true, bidCount: 1 }, tx: 'REFUNDED' },
  PAYMENT_DEFAULTED: { listing: 'APPROVED', auction: { status: 'CLOSED', reserveMet: true, bidCount: 1 }, tx: 'VOIDED' },
  RELISTED: { listing: 'APPROVED', auction: { status: 'CLOSED', reserveMet: true, bidCount: 1 }, tx: 'VOIDED' },
  ENDED_RESERVE_NOT_MET: { listing: 'APPROVED', auction: { status: 'CLOSED', reserveMet: false, bidCount: 2 } },
  ENDED_NO_BIDS: { listing: 'APPROVED', auction: { status: 'CLOSED', reserveMet: null, bidCount: 0 } },
  CANCELLED: { listing: 'APPROVED', auction: { status: 'CANCELLED' } },
};

interface SeedOptions {
  sellerId?: string;
  title?: string;
  endTime?: Date;
  submittedAt?: Date;
  /** Overrides SPEC[stage] for the cases that combine states the table does not. */
  spec?: Spec;
}

interface Seeded {
  listingId: string;
  auctionId?: string;
  txId?: string;
  code: string;
}

async function seedItem(stage: Stage, o: SeedOptions = {}): Promise<Seeded> {
  seq += 1;
  const spec = o.spec ?? SPEC[stage];
  const sellerId = o.sellerId ?? w.seller.id;
  const code = `TEST-SI-${seq}`;
  const now = Date.now();
  const listing = await prisma.listing.create({
    data: {
      listingCode: code,
      sellerId,
      title: o.title ?? `Item ${stage} ${seq}`,
      category: 'Books & Education',
      condition: 'USED',
      description: 'A seeded item for the seller items tests.',
      startPrice: 1_000,
      reservePrice: 1_500,
      minIncrement: 100,
      durationDays: 3,
      status: spec.listing,
      rejectionReason: spec.listing === 'REJECTED' || spec.listing === 'REMOVED' ? 'Seeded reason.' : null,
      submittedAt: o.submittedAt ?? new Date(now - seq * MIN),
    },
  });
  if (!spec.auction) return { listingId: listing.id, code };

  const open = spec.auction.open ?? false;
  const auction = await prisma.auction.create({
    data: {
      listingId: listing.id,
      sellerId,
      title: listing.title,
      category: listing.category,
      condition: listing.condition,
      description: listing.description,
      startPrice: listing.startPrice,
      reservePrice: listing.reservePrice,
      reserveMet: spec.auction.reserveMet ?? null,
      minIncrement: listing.minIncrement,
      currentBid: 1_000,
      bidCount: spec.auction.bidCount ?? 0,
      status: spec.auction.status,
      startTime: new Date(now - 5 * DAY),
      endTime: o.endTime ?? (open ? new Date(now + (1 + seq) * 60 * MIN) : new Date(now - seq * 60 * MIN)),
    },
  });
  if (!spec.tx) return { listingId: listing.id, auctionId: auction.id, code };

  const paid = ['COMPLETED', 'SHIPPED', 'DELIVERED', 'DISPUTED', 'REFUNDED'].includes(spec.tx);
  const tx = await prisma.auctionTransaction.create({
    data: {
      auctionId: auction.id,
      winnerId: w.buyer.id,
      sellerId,
      finalAmount: 8_000,
      status: spec.tx,
      deliveryAddress: paid ? '123 Test Street, Karachi' : null,
      deliveryPhone: paid ? '03001234567' : null,
      paidAt: paid ? new Date(now - 3 * 60 * MIN) : null,
      shippedAt: ['SHIPPED', 'DELIVERED', 'DISPUTED', 'REFUNDED'].includes(spec.tx) ? new Date(now - 2 * 60 * MIN) : null,
    },
  });
  if (spec.dispute) {
    await prisma.dispute.create({
      data: {
        transactionId: tx.id,
        raisedByUserId: w.buyer.id,
        reason: 'The item never arrived at my address.',
        createdAt: new Date(now - 1 * DAY),
        ...(spec.dispute === 'answered'
          ? { sellerResponse: 'Shipped with tracking, delivered per the courier.', sellerRespondedAt: new Date(now - 12 * 60 * MIN) }
          : {}),
      },
    });
  }
  return { listingId: listing.id, auctionId: auction.id, txId: tx.id, code };
}

/** The relist that makes a RELISTED row: a second, live listing created from the first. */
async function relistOf(original: Seeded): Promise<Seeded> {
  const created = await seedItem('LIVE');
  await prisma.listing.update({ where: { id: created.listingId }, data: { relistedFromId: original.listingId } });
  return created;
}

async function seedAllStages() {
  const expected = new Map<string, Stage>();
  for (const stage of SELLER_ITEM_STAGES) {
    const item = await seedItem(stage);
    expected.set(item.listingId, stage);
    if (stage === 'RELISTED') expected.set((await relistOf(item)).listingId, 'LIVE');
  }
  return expected;
}

// ---- helpers --------------------------------------------------------------------------------

const getItems = (token: string | undefined, query: string) => {
  const req = request(app).get(api(`/seller/items${query}`));
  return token ? req.set(auth(token)) : req;
};

/** Every page of a tab, concatenated, plus how many pages it took. */
async function listTab(token: string, tab: string, extra = '', limit = 3) {
  const items: Row[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const q: string = `?tab=${tab}&limit=${limit}${extra}${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await getItems(token, q);
    expect(res.status).toBe(200);
    const page = resData<Paginated<Row>>(res);
    items.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);
  return { items, pages };
}

const summary = async (token: string, query = '') => {
  const res = await request(app).get(api(`/seller/items/summary${query}`)).set(auth(token));
  expect(res.status).toBe(200);
  return resData<{ counts: Record<Tab, number> }>(res).counts;
};

// ---- tests ----------------------------------------------------------------------------------

describe('tabs', () => {
  it('every tab lists exactly the stages mapped to it', async () => {
    const expected = await seedAllStages();

    for (const tab of SELLER_ITEM_TABS) {
      const { items } = await listTab(w.seller.token, tab);
      for (const item of items) {
        expect(item.tab).toBe(tab);
        expect(STAGE_TAB[item.stage]).toBe(tab);
      }
      const seededStages = items.filter((i) => expected.has(i.itemId)).map((i) => i.stage);
      const wanted = [...expected.values()].filter((s) => STAGE_TAB[s] === tab);
      expect(seededStages.sort()).toEqual(wanted.sort());
    }
  });

  it("the six tabs partition all of the seller's items", async () => {
    const expected = await seedAllStages();

    const seen = new Map<string, Stage>();
    for (const tab of SELLER_ITEM_TABS) {
      for (const item of (await listTab(w.seller.token, tab)).items) {
        expect(seen.has(item.itemId)).toBe(false);
        seen.set(item.itemId, item.stage);
      }
    }

    const all = await prisma.listing.findMany({ where: { sellerId: w.seller.id }, select: { id: true } });
    expect([...seen.keys()].sort()).toEqual(all.map((l) => l.id).sort());
    for (const [id, stage] of expected) expect(seen.get(id)).toBe(stage);
  });

  it('summary counts equal the tab list lengths', async () => {
    await seedAllStages();
    const counts = await summary(w.seller.token);

    for (const tab of SELLER_ITEM_TABS) {
      expect(counts[tab]).toBe((await listTab(w.seller.token, tab)).items.length);
    }
  });

  it('a missing or unknown tab means action', async () => {
    await seedAllStages();
    const action = (await listTab(w.seller.token, 'action')).items.map((i) => i.itemId).sort();

    for (const query of ['', '?tab=nonsense', '?tab=']) {
      const res = await getItems(w.seller.token, query);
      expect(res.status).toBe(200);
      expect(resData<Paginated<Row>>(res).items.map((i) => i.itemId).sort()).toEqual(action);
    }
  });

  it('a seller with no items gets empty tabs and zero counts', async () => {
    const fresh = await prisma.user.create({
      data: { name: 'Fresh Seller', email: 'fresh-seller@test.local', passwordHash: 'x', role: 'SELLER', isEmailVerified: true },
    });
    const token = signAccessToken({ sub: fresh.id, role: 'SELLER' });

    for (const tab of SELLER_ITEM_TABS) {
      const res = await getItems(token, `?tab=${tab}`);
      expect(res.status).toBe(200);
      expect(resData<Paginated<Row>>(res)).toEqual({ items: [], nextCursor: null });
    }
    expect(await summary(token)).toEqual({ action: 0, review: 0, live: 0, sold: 0, unsold: 0, closed: 0 });
  });
});

describe('ordering and paging', () => {
  it('live and action list the soonest-ending first, sold and unsold the most recently ended first', async () => {
    const now = Date.now();
    const a = await seedItem('LIVE', { endTime: new Date(now + 3 * 60 * MIN) });
    const b = await seedItem('LIVE', { endTime: new Date(now + 1 * 60 * MIN) });
    const c = await seedItem('SHIPPED', { endTime: new Date(now - 3 * 60 * MIN) });
    const d = await seedItem('SHIPPED', { endTime: new Date(now - 1 * 60 * MIN) });
    const e = await seedItem('NEEDS_SHIPPING', { endTime: new Date(now - 5 * 60 * MIN) });
    const f = await seedItem('NEEDS_SHIPPING', { endTime: new Date(now - 9 * 60 * MIN) });

    const ids = async (tab: string, wanted: string[]) =>
      (await listTab(w.seller.token, tab)).items.map((i) => i.itemId).filter((id) => wanted.includes(id));

    expect(await ids('live', [a.listingId, b.listingId])).toEqual([b.listingId, a.listingId]);
    expect(await ids('sold', [c.listingId, d.listingId])).toEqual([d.listingId, c.listingId]);
    expect(await ids('action', [e.listingId, f.listingId])).toEqual([f.listingId, e.listingId]);
  });

  it('review and closed list the most recently submitted first', async () => {
    const now = Date.now();
    const old = await seedItem('UNDER_REVIEW', { submittedAt: new Date(now - 9 * DAY) });
    const fresh = await seedItem('UNDER_REVIEW', { submittedAt: new Date(now - 1 * MIN) });

    const ids = (await listTab(w.seller.token, 'review')).items.map((i) => i.itemId);
    expect(ids.indexOf(fresh.listingId)).toBeLessThan(ids.indexOf(old.listingId));
  });

  it('pages do not duplicate or skip when auctions end at the same instant', async () => {
    const sameInstant = new Date(Date.now() + 2 * 60 * MIN);
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await seedItem('LIVE', { endTime: sameInstant }));

    const { items, pages } = await listTab(w.seller.token, 'live', '', 2);

    const ids = items.map((i) => i.itemId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of made) expect(ids).toContain(m.listingId);
    expect(pages).toBeGreaterThanOrEqual(3);
  });
});

describe('who can call it', () => {
  it("a seller sees only their own items", async () => {
    await seedAllStages();
    const mine = await seedItem('LIVE', { title: 'Mine' });
    const theirs = await seedItem('LIVE', { title: 'Theirs', sellerId: w.otherSeller.id });

    const own = (await listTab(w.seller.token, 'live')).items.map((i) => i.itemId);
    expect(own).toContain(mine.listingId);
    expect(own).not.toContain(theirs.listingId);

    const other = (await listTab(w.otherSeller.token, 'live')).items.map((i) => i.itemId);
    expect(other).toContain(theirs.listingId);
    expect(other).not.toContain(mine.listingId);

    const counts = await summary(w.otherSeller.token);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(await prisma.listing.count({ where: { sellerId: w.otherSeller.id } }));
  });

  it('a buyer gets 403 and an anonymous caller 401', async () => {
    expect((await getItems(w.buyer.token, '')).status).toBe(403);
    expect((await getItems(undefined, '')).status).toBe(401);
    expect((await request(app).get(api('/seller/items/summary')).set(auth(w.buyer.token))).status).toBe(403);
    expect((await request(app).get(api('/seller/items/summary'))).status).toBe(401);
  });

  it('the response never contains sellerEmail', async () => {
    await seedAllStages();
    const res = await getItems(w.seller.token, '?tab=action');
    expect(res.status).toBe(200);
    expect(resData<Paginated<Row>>(res).items.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/sellerEmail|seller@test\.local/);
  });
});

describe('stage edge cases', () => {
  it('a REMOVED listing with a COMPLETED sale is in action', async () => {
    const item = await seedItem('NEEDS_SHIPPING', {
      spec: { listing: 'REMOVED', auction: { status: 'CLOSED', reserveMet: true, bidCount: 1 }, tx: 'COMPLETED' },
    });

    const row = (await listTab(w.seller.token, 'action')).items.find((i) => i.itemId === item.listingId);
    expect(row?.stage).toBe('NEEDS_SHIPPING');
    expect(row?.actions).toContain('MARK_SHIPPED');
    expect((await listTab(w.seller.token, 'closed')).items.some((i) => i.itemId === item.listingId)).toBe(false);
  });

  it('an ACTIVE auction past its endTime is still live', async () => {
    const item = await seedItem('LIVE', { endTime: new Date(Date.now() - 10 * MIN) });

    const row = (await listTab(w.seller.token, 'live')).items.find((i) => i.itemId === item.listingId);
    expect(row?.stage).toBe('LIVE');
    expect((await listTab(w.seller.token, 'unsold')).items.some((i) => i.itemId === item.listingId)).toBe(false);
  });

  it('a relisted VOIDED sale is RELISTED and points at its relist', async () => {
    const original = await seedItem('RELISTED');
    const relist = await relistOf(original);

    const row = (await listTab(w.seller.token, 'unsold')).items.find((i) => i.itemId === original.listingId);
    expect(row?.stage).toBe('RELISTED');
    expect(row?.actions).toEqual([]);
    expect(row?.relistedAs).toEqual({ listingId: relist.listingId, listingCode: relist.code });
  });

  it('a dispute leaves action for sold once the seller responds', async () => {
    const waiting = await seedItem('DISPUTE_AWAITING_RESPONSE');
    const answered = await seedItem('DISPUTED');

    const action = (await listTab(w.seller.token, 'action')).items;
    const sold = (await listTab(w.seller.token, 'sold')).items;
    const w1 = action.find((i) => i.itemId === waiting.listingId);
    expect(w1?.actions).toEqual(['RESPOND_TO_DISPUTE', 'VIEW_INVOICE']);
    expect(w1?.sale?.disputeResponseDueAt).toBeDefined();
    expect(w1?.sale?.disputeSellerResponse).toBeUndefined();
    const a1 = sold.find((i) => i.itemId === answered.listingId);
    expect(a1?.stage).toBe('DISPUTED');
    expect(a1?.sale?.disputeSellerResponse).toMatch(/Shipped with tracking/);
  });
});

describe('payment defaulted: the next bidder preview', () => {
  async function defaulted(bids: Array<[string, number]>, previous: string[] = []) {
    const item = await seedItem('PAYMENT_DEFAULTED');
    for (const [buyerId, amount] of bids) await prisma.bid.create({ data: { auctionId: item.auctionId!, buyerId, amount } });
    if (previous.length) {
      await prisma.auctionTransaction.update({ where: { id: item.txId! }, data: { previousWinnerIds: previous } });
    }
    const row = (await listTab(w.seller.token, 'action')).items.find((i) => i.itemId === item.listingId);
    return row!;
  }

  it('carries nextBidderOffer and OFFER_NEXT_BIDDER when somebody else bid', async () => {
    const row = await defaulted([[w.buyer.id, 8_000], [w.otherBuyer.id, 7_000]]);
    expect(row.stage).toBe('PAYMENT_DEFAULTED');
    expect(row.sale?.nextBidderOffer).toBe(7_000);
    expect(row.actions).toEqual(['RELIST', 'OFFER_NEXT_BIDDER']);
  });

  it('is null, with only RELIST, when nobody else bid', async () => {
    const row = await defaulted([[w.buyer.id, 8_000]]);
    expect(row.sale?.nextBidderOffer).toBeNull();
    expect(row.actions).toEqual(['RELIST']);
  });

  it('skips earlier defaulters, as the offer itself will', async () => {
    const row = await defaulted(
      [[w.buyer.id, 8_000], [w.otherBuyer.id, 7_000], [thirdBuyerId, 6_000]],
      [w.otherBuyer.id],
    );
    expect(row.sale?.nextBidderOffer).toBe(6_000);
  });
});

describe('what a row carries', () => {
  it('has the actions each stage allows and the facts the screen shows', async () => {
    const expected = await seedAllStages();
    const byStage = new Map<Stage, Row>();
    for (const tab of SELLER_ITEM_TABS) {
      for (const item of (await listTab(w.seller.token, tab)).items) {
        if (expected.has(item.itemId)) byStage.set(item.stage, item);
      }
    }

    expect(byStage.get('UNDER_REVIEW')?.actions).toEqual(['WITHDRAW']);
    expect(byStage.get('REJECTED')?.actions).toEqual(['EDIT_RESUBMIT']);
    expect(byStage.get('REJECTED')?.listing.rejectionReason).toBe('Seeded reason.');
    expect(byStage.get('REMOVED')?.listing.rejectionReason).toBe('Seeded reason.');
    expect(byStage.get('LIVE')?.actions).toEqual(['CANCEL_AUCTION']);
    expect(byStage.get('NEEDS_SHIPPING')?.actions).toEqual(['MARK_SHIPPED', 'VIEW_INVOICE']);
    expect(byStage.get('NEEDS_SHIPPING')?.sale?.paidAt).toBeDefined();
    expect(byStage.get('NEEDS_SHIPPING')?.sale?.buyerName).toBe('Test Buyer');
    expect(byStage.get('ENDED_NO_BIDS')?.actions).toEqual(['LIST_AGAIN']);
    expect(byStage.get('ENDED_RESERVE_NOT_MET')?.actions).toEqual(['LIST_AGAIN']);
    expect(byStage.get('ENDED_RESERVE_NOT_MET')?.listing.description).toBe('A seeded item for the seller items tests.');
    expect(byStage.get('ENDED_RESERVE_NOT_MET')?.listing.reservePrice).toBe(1_500);
    expect(byStage.get('CANCELLED')?.actions).toEqual([]);
    expect(byStage.get('LIVE')?.auction?.watcherCount).toBe(0);
  });
});

describe('search', () => {
  it('matches title or code, case-insensitively, inside the tab only', async () => {
    const liveLamp = await seedItem('LIVE', { title: 'Vintage Lamp' });
    const soldClock = await seedItem('SHIPPED', { title: 'Vintage Clock' });
    await seedItem('LIVE', { title: 'Plain Mug' });

    const live = (await listTab(w.seller.token, 'live', '&search=vintage')).items;
    expect(live.map((i) => i.itemId)).toEqual([liveLamp.listingId]);

    const sold = (await listTab(w.seller.token, 'sold', '&search=VINTAGE')).items;
    expect(sold.map((i) => i.itemId)).toEqual([soldClock.listingId]);

    const byCode = (await listTab(w.seller.token, 'live', `&search=${liveLamp.code.toLowerCase()}`)).items;
    expect(byCode.map((i) => i.itemId)).toEqual([liveLamp.listingId]);
  });

  it('does not change the tab counts', async () => {
    await seedItem('LIVE', { title: 'Vintage Lamp' });
    await seedItem('LIVE', { title: 'Plain Mug' });

    expect(await summary(w.seller.token, '?search=vintage')).toEqual(await summary(w.seller.token));
  });

  it('treats % and _ literally', async () => {
    const pct = await seedItem('LIVE', { title: 'Sale 50% off' });
    await seedItem('LIVE', { title: 'Sale 50x off' });
    const under = await seedItem('LIVE', { title: 'part a_c' });
    await seedItem('LIVE', { title: 'part abc' });

    expect((await listTab(w.seller.token, 'live', '&search=50%25')).items.map((i) => i.itemId)).toEqual([pct.listingId]);
    expect((await listTab(w.seller.token, 'live', '&search=a_c')).items.map((i) => i.itemId)).toEqual([under.listingId]);
  });

  it('pages stably with a cursor', async () => {
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await seedItem('LIVE', { title: `Cursor Item ${i}` }));

    const { items, pages } = await listTab(w.seller.token, 'live', '&search=cursor%20item', 2);

    const ids = items.map((i) => i.itemId);
    expect(new Set(ids).size).toBe(5);
    expect(ids.sort()).toEqual(made.map((m) => m.listingId).sort());
    expect(pages).toBe(3);
  });

  it('over 100 characters is a 400', async () => {
    const res = await getItems(w.seller.token, `?tab=live&search=${'x'.repeat(101)}`);
    expect(res.status).toBe(400);
    expect(resError(res).error).toMatch(/100 characters/);
    expect((await getItems(w.seller.token, `?tab=live&search=${'x'.repeat(100)}`)).status).toBe(200);
  });

  it('an empty or blank search is no filter', async () => {
    const item = await seedItem('LIVE', { title: 'Anything' });
    for (const s of ['', '%20%20']) {
      const ids = (await listTab(w.seller.token, 'live', `&search=${s}`)).items.map((i) => i.itemId);
      expect(ids).toContain(item.listingId);
    }
  });
});
