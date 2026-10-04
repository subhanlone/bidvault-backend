/**
 * Cache-Control on the API.
 *
 * Almost everything under /api/v1 is about one signed-in caller, and the sign-in routes return
 * the tokens themselves. The API used to send no Cache-Control at all, leaving it to whatever sits
 * in between and to default heuristics. Now every /api/v1 response carries `no-store` (RFC 9111
 * 5.2.2.5: no cache of any kind may store it), including the ones that never reach a route.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: vi.fn(() => Promise.resolve({ data: { id: 'email_test' }, error: null })) };
  },
}));

const { createApp } = await import('../src/app.js');
const { noStore } = await import('../src/middleware/no-store.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { takeViolations } = await import('../src/middleware/response-contract.js');
const { seedWorld, PASSWORD } = await import('./helpers/world.js');

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
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

const cacheControl = (res: { headers: Record<string, unknown> }) => res.headers['cache-control'];

describe('every /api/v1 response is no-store', () => {
  it('a public read', async () => {
    expect(cacheControl(await request(app).get(api('/settings/public')))).toBe('no-store');
    expect(cacheControl(await request(app).get(api('/stats')))).toBe('no-store');
    expect(cacheControl(await request(app).get(api('/health')))).toBe('no-store');
  });

  it('a public read whose answer depends on who is asking (bids mark the caller\'s own)', async () => {
    const res = await request(app).get(api(`/auctions/${w.liveAuctionId}/bids`)).set(auth(w.buyer.token));
    expect(res.status).toBe(200);
    expect(cacheControl(res)).toBe('no-store');
  });

  it('the sign-in response that carries the tokens', async () => {
    const res = await request(app).post(api('/auth/login')).send({ email: w.buyer.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(cacheControl(res)).toBe('no-store');
  });

  it('authenticated reads for each role', async () => {
    expect(cacheControl(await request(app).get(api('/auth/me')).set(auth(w.buyer.token)))).toBe('no-store');
    expect(cacheControl(await request(app).get(api('/auctions/mine/bids')).set(auth(w.buyer.token)))).toBe('no-store');
    expect(cacheControl(await request(app).get(api('/listings/mine')).set(auth(w.seller.token)))).toBe('no-store');
    expect(cacheControl(await request(app).get(api('/admin/users')).set(auth(w.admin.token)))).toBe('no-store');
  });

  it('failures: unauthenticated, wrong role, invalid body, unknown path', async () => {
    const unauth = await request(app).get(api('/auth/me'));
    expect(unauth.status).toBe(401);
    expect(cacheControl(unauth)).toBe('no-store');

    const wrongRole = await request(app).get(api('/listings/pending')).set(auth(w.buyer.token));
    expect(wrongRole.status).toBe(403);
    expect(cacheControl(wrongRole)).toBe('no-store');

    const invalid = await request(app).post(api('/auth/login')).send({});
    expect(invalid.status).toBe(400);
    expect(cacheControl(invalid)).toBe('no-store');

    const unknown = await request(app).get(api('/does-not-exist')).set(auth(w.buyer.token));
    expect(unknown.status).toBe(404);
    expect(cacheControl(unknown)).toBe('no-store');
  });

  it('a request from a refused origin, which never reaches a route (it is stopped by CORS)', async () => {
    const res = await request(app).get(api('/stats')).set('Origin', 'https://not-our-frontend.example');
    expect(res.status).toBe(403);
    expect(cacheControl(res)).toBe('no-store');
  });
});

describe('the middleware itself', () => {
  it('is only mounted on /api/v1, so it does not decide for anything else', async () => {
    const res = await request(app).get('/not-the-api');
    expect(cacheControl(res)).toBeUndefined();
  });

  it('is a default, not a lock: a handler that has a reason can set its own Cache-Control after it', async () => {
    const mini = express();
    mini.use(noStore);
    mini.get('/default', (_req, res) => { res.json({ ok: true }); });
    mini.get('/override', (_req, res) => { res.set('Cache-Control', 'public, max-age=60').json({ ok: true }); });
    expect(cacheControl(await request(mini).get('/default'))).toBe('no-store');
    expect(cacheControl(await request(mini).get('/override'))).toBe('public, max-age=60');
  });
});
