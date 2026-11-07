/**
 * What a person without an account may read on BidVault, and what stays behind a sign-in.
 *
 * Guest browsing (B5 follow-on): anyone can look at an auction, live or ended, but the list of
 * bids (D10) and the masked bid entries on the live socket feed are for signed-in members. A
 * guest's live feed carries numbers only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

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

type World = Awaited<ReturnType<typeof seedWorld>>;

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let w: World;

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  w = await seedWorld();
});

afterEach(() => {
  takeViolations();
  vi.restoreAllMocks();
  app.set('io', undefined);
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

interface Emitted {
  room: string;
  event: string;
  payload: unknown;
}

function captureSocketEmits(): Emitted[] {
  const emitted: Emitted[] = [];
  app.set('io', {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        emitted.push({ room, event, payload });
      },
    }),
  });
  return emitted;
}

describe('live feed per audience', () => {
  // world.ts: the live auction has one bid (buyer, 21,000), increment 1,000.
  const placeBid = (amount: number) =>
    request(app)
      .post(api(`/auctions/${w.liveAuctionId}/bids`))
      .set(auth(w.otherBuyer.token))
      .send({ amount });

  it('sends the masked bid entry only to the members room', async () => {
    const emitted = captureSocketEmits();
    expect((await placeBid(22_000)).status).toBe(201);

    const placed = emitted.filter((e) => e.event === 'bid:placed');
    expect(placed.map((e) => e.room)).toEqual([`auction:${w.liveAuctionId}:members`]);
  });

  it('sends the guests room the price and the count and nothing else', async () => {
    const emitted = captureSocketEmits();
    expect((await placeBid(22_000)).status).toBe(201);

    const price = emitted.filter((e) => e.event === 'auction:price');
    expect(price).toHaveLength(1);
    expect(price[0].room).toBe(`auction:${w.liveAuctionId}:guests`);
    // toEqual, so a bidder name, id or any other field cannot be added without failing this.
    expect(price[0].payload).toEqual({ auctionId: w.liveAuctionId, currentBid: 22_000, bidCount: 2 });
  });

  it('sends nothing about a bid to the bare auction room that every socket joins', async () => {
    const emitted = captureSocketEmits();
    expect((await placeBid(22_000)).status).toBe(201);

    expect(emitted.filter((e) => e.room === `auction:${w.liveAuctionId}`)).toEqual([]);
  });
});
