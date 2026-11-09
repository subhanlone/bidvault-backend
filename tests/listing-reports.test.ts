/**
 * G5 (docs/superpowers/plans/2026-11-06-guest-browsing.md, decision H): anyone with an account can
 * report a listing they think breaks the rules; one report per person per auction (a repeat gives
 * back the report they already made). An admin lists the reports and marks each one actioned or
 * dismissed, which is audited. Resolving does not touch the auction: an admin who decides the
 * listing must go uses the existing takedown or cancel control.
 *
 * The listed seller never learns who reported them: no seller-facing response carries a report.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
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

type World = Awaited<ReturnType<typeof seedWorld>>;

interface ReportDto {
  reportId: string;
  auctionId: string;
  reason: string;
  note?: string;
  status: string;
  createdAt: string;
}

interface AdminReportDto {
  reportId: string;
  auction: { auctionId: string; title: string; listingCode: string; status: string; sellerName: string };
  reason: string;
  note?: string;
  reporterName: string;
  status: string;
  createdAt: string;
  resolvedAt?: string;
}

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let w: World;

const report = (token: string, auctionId: string, body: object = { reason: 'COUNTERFEIT', note: 'The logo is misspelt.' }) =>
  request(app).post(api(`/auctions/${auctionId}/report`)).set(auth(token)).send(body);

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  w = await seedWorld();
});

afterEach(() => {
  expect(takeViolations()).toEqual([]);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

describe('POST /auctions/{auctionId}/report', () => {
  it('a signed-in buyer reports a live auction', async () => {
    const res = await report(w.buyer.token, w.liveAuctionId);

    expect(res.status).toBe(200);
    expect(resData<{ alreadyReported: boolean }>(res).alreadyReported).toBe(false);
    const dto = resData<{ report: ReportDto }>(res).report;
    expect(dto).toMatchObject({ auctionId: w.liveAuctionId, reason: 'COUNTERFEIT', note: 'The logo is misspelt.', status: 'OPEN' });
    const rows = await prisma.listingReport.findMany({ where: { auctionId: w.liveAuctionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reporterId).toBe(w.buyer.id);
  });

  it('a repeat by the same person gives back the same report and adds no row', async () => {
    const first = await report(w.buyer.token, w.liveAuctionId);
    const again = await report(w.buyer.token, w.liveAuctionId, { reason: 'MISLEADING' });

    expect(again.status).toBe(200);
    expect(resData<{ alreadyReported: boolean }>(again).alreadyReported).toBe(true);
    expect(resData<{ report: ReportDto }>(again).report.reportId).toBe(resData<{ report: ReportDto }>(first).report.reportId);
    expect(resData<{ report: ReportDto }>(again).report.reason).toBe('COUNTERFEIT');
    expect(await prisma.listingReport.count()).toBe(1);
  });

  it('two people reporting the same auction make two reports', async () => {
    await report(w.buyer.token, w.liveAuctionId);
    await report(w.otherBuyer.token, w.liveAuctionId);
    expect(await prisma.listingReport.count({ where: { auctionId: w.liveAuctionId } })).toBe(2);
  });

  it('an ended auction can be reported too', async () => {
    const res = await report(w.buyer.token, w.otherBuyerWatchedAuctionId);
    expect(res.status).toBe(200);
    expect(resData<{ alreadyReported: boolean }>(res).alreadyReported).toBe(false);
  });

  it('two simultaneous reports by one person still make one row', async () => {
    const results = await Promise.all([report(w.buyer.token, w.liveAuctionId), report(w.buyer.token, w.liveAuctionId)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => resData<{ alreadyReported: boolean }>(r).alreadyReported).sort()).toEqual([false, true]);
    expect(await prisma.listingReport.count()).toBe(1);
  });

  it('needs an account', async () => {
    const res = await request(app).post(api(`/auctions/${w.liveAuctionId}/report`)).send({ reason: 'OTHER' });
    expect(res.status).toBe(401);
  });

  it('an admin does not file reports', async () => {
    const res = await report(w.admin.token, w.liveAuctionId);
    expect(res.status).toBe(403);
  });

  it('the seller cannot report their own auction', async () => {
    const res = await report(w.seller.token, w.liveAuctionId);
    expect(res.status).toBe(403);
    expect(resError(res).error).toMatch(/your own/i);
    expect(await prisma.listingReport.count()).toBe(0);
  });

  it('an unknown auction is a 404', async () => {
    const res = await report(w.buyer.token, 'no-such-auction');
    expect(res.status).toBe(404);
  });

  it('a removed (cancelled) auction cannot be reported', async () => {
    await prisma.auction.update({ where: { id: w.liveAuctionId }, data: { status: 'CANCELLED' } });
    const res = await report(w.buyer.token, w.liveAuctionId);
    expect(res.status).toBe(409);
    expect(await prisma.listingReport.count()).toBe(0);
  });

  it('refuses a note over 500 characters and an unknown reason', async () => {
    const long = await report(w.buyer.token, w.liveAuctionId, { reason: 'OTHER', note: 'x'.repeat(501) });
    expect(long.status).toBe(400);
    const unknown = await report(w.buyer.token, w.liveAuctionId, { reason: 'RUDE' });
    expect(unknown.status).toBe(400);
    expect(await prisma.listingReport.count()).toBe(0);
  });

  it('the listed seller never sees who reported them', async () => {
    await report(w.buyer.token, w.liveAuctionId);
    const responses = await Promise.all([
      request(app).get(api(`/auctions/${w.liveAuctionId}`)).set(auth(w.seller.token)),
      request(app).get(api('/seller/items?tab=live')).set(auth(w.seller.token)),
      request(app).get(api('/notifications')).set(auth(w.seller.token)),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(w.buyer.id);
      expect(body).not.toMatch(/report/i);
    }
  });
});

describe('GET /admin/reports', () => {
  it('lists open reports, oldest first, with the auction and the reporter', async () => {
    await report(w.buyer.token, w.liveAuctionId);
    await report(w.otherBuyer.token, w.liveAuctionId, { reason: 'PROHIBITED_ITEM' });

    const res = await request(app).get(api('/admin/reports')).set(auth(w.admin.token));
    expect(res.status).toBe(200);
    const items = resData<Paginated<AdminReportDto>>(res).items;
    expect(items.map((r) => r.reporterName)).toEqual(['Test Buyer', 'Other Buyer']);
    expect(items[0].auction).toMatchObject({ auctionId: w.liveAuctionId, title: 'Live Test Auction', listingCode: 'TEST-LIVE-1', status: 'ACTIVE', sellerName: 'Test Seller' });
    expect(items[0]).toMatchObject({ reason: 'COUNTERFEIT', note: 'The logo is misspelt.', status: 'OPEN' });
  });

  it('pages with a cursor', async () => {
    await report(w.buyer.token, w.liveAuctionId);
    await report(w.otherBuyer.token, w.liveAuctionId);
    const first = resData<Paginated<AdminReportDto>>(await request(app).get(api('/admin/reports?limit=1')).set(auth(w.admin.token)));
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = resData<Paginated<AdminReportDto>>(
      await request(app).get(api(`/admin/reports?limit=1&cursor=${first.nextCursor}`)).set(auth(w.admin.token)),
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0].reportId).not.toBe(first.items[0].reportId);
    expect(second.nextCursor).toBeNull();
  });

  it('filters by status', async () => {
    const id = resData<{ report: ReportDto }>(await report(w.buyer.token, w.liveAuctionId)).report.reportId;
    await report(w.otherBuyer.token, w.liveAuctionId);
    await request(app).patch(api(`/admin/reports/${id}`)).set(auth(w.admin.token)).send({ status: 'DISMISSED' });

    const open = resData<Paginated<AdminReportDto>>(await request(app).get(api('/admin/reports')).set(auth(w.admin.token)));
    expect(open.items.map((r) => r.reporterName)).toEqual(['Other Buyer']);
    const dismissed = resData<Paginated<AdminReportDto>>(
      await request(app).get(api('/admin/reports?status=DISMISSED')).set(auth(w.admin.token)),
    );
    expect(dismissed.items.map((r) => r.reportId)).toEqual([id]);
    expect(dismissed.items[0].resolvedAt).toBeDefined();
  });

  it('refuses an unknown status filter', async () => {
    const res = await request(app).get(api('/admin/reports?status=LOST')).set(auth(w.admin.token));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /admin/reports/{reportId}', () => {
  it('marks a report actioned, stamps who and when, and audits it', async () => {
    const id = resData<{ report: ReportDto }>(await report(w.buyer.token, w.liveAuctionId)).report.reportId;
    const res = await request(app).patch(api(`/admin/reports/${id}`)).set(auth(w.admin.token)).send({ status: 'ACTIONED' });

    expect(res.status).toBe(200);
    const row = await prisma.listingReport.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ACTIONED');
    expect(row.resolvedById).toBe(w.admin.id);
    expect(row.resolvedAt).not.toBeNull();
    const audit = await prisma.auditLog.findMany({ where: { action: 'LISTING_REPORT_RESOLVED', entityId: id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(w.admin.id);
  });

  it('does not change the auction', async () => {
    const id = resData<{ report: ReportDto }>(await report(w.buyer.token, w.liveAuctionId)).report.reportId;
    await request(app).patch(api(`/admin/reports/${id}`)).set(auth(w.admin.token)).send({ status: 'ACTIONED' });
    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } });
    expect(auction.status).toBe('ACTIVE');
  });

  it('resolving twice the same way is idempotent: one audit row', async () => {
    const id = resData<{ report: ReportDto }>(await report(w.buyer.token, w.liveAuctionId)).report.reportId;
    const send = () => request(app).patch(api(`/admin/reports/${id}`)).set(auth(w.admin.token)).send({ status: 'DISMISSED' });
    const results = await Promise.all([send(), send()]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await prisma.auditLog.count({ where: { action: 'LISTING_REPORT_RESOLVED', entityId: id } })).toBe(1);
  });

  it('a report already resolved the other way is a 409', async () => {
    const id = resData<{ report: ReportDto }>(await report(w.buyer.token, w.liveAuctionId)).report.reportId;
    await request(app).patch(api(`/admin/reports/${id}`)).set(auth(w.admin.token)).send({ status: 'DISMISSED' });
    const res = await request(app).patch(api(`/admin/reports/${id}`)).set(auth(w.admin.token)).send({ status: 'ACTIONED' });
    expect(res.status).toBe(409);
    expect((await prisma.listingReport.findUniqueOrThrow({ where: { id } })).status).toBe('DISMISSED');
  });

  it('an unknown report is a 404, and OPEN is not a resolution', async () => {
    const missing = await request(app).patch(api('/admin/reports/nope')).set(auth(w.admin.token)).send({ status: 'ACTIONED' });
    expect(missing.status).toBe(404);
    const id = resData<{ report: ReportDto }>(await report(w.buyer.token, w.liveAuctionId)).report.reportId;
    const reopen = await request(app).patch(api(`/admin/reports/${id}`)).set(auth(w.admin.token)).send({ status: 'OPEN' });
    expect(reopen.status).toBe(400);
  });
});
