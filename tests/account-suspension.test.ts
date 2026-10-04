/**
 * Phase 7 (LIFECYCLE-IMPLEMENTATION-PLAN.md): C2 — an admin can suspend and reinstate an
 * account. Reversible and does not touch the account's data, unlike anonymize (BV-018). A
 * suspended account loses every authenticated action, enforced once in requireAuth rather than
 * per-route.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resData, resError, type Paginated } from './helpers/api.js';

interface UserStatusDto {
  status: string;
}

interface UserDirectoryEntry {
  userId: string;
  status: string;
}

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
const { invalidateUserStatusCache } = await import('../src/services/user-status.service.js');

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

describe('suspend / reinstate', () => {
  it('suspends an account and it can no longer authenticate', async () => {
    const res = await request(app)
      .post(api(`/admin/users/${w.otherBuyer.id}/suspend`))
      .set(auth(w.admin.token))
      .send({ reason: 'Repeated non-payment.' });
    expect(res.status).toBe(200);
    expect(resData<UserStatusDto>(res).status).toBe('SUSPENDED');

    const row = await prisma.user.findUniqueOrThrow({ where: { id: w.otherBuyer.id } });
    expect(row.status).toBe('SUSPENDED');

    const blocked = await request(app).get(api('/auth/me')).set(auth(w.otherBuyer.token));
    expect(blocked.status).toBe(403);
    expect(resError(blocked).error).toMatch(/suspended/i);
  });

  it('reinstates a suspended account, restoring access', async () => {
    await prisma.user.update({ where: { id: w.otherBuyer.id }, data: { status: 'SUSPENDED' } });
    invalidateUserStatusCache(w.otherBuyer.id);

    const res = await request(app)
      .post(api(`/admin/users/${w.otherBuyer.id}/reinstate`))
      .set(auth(w.admin.token));
    expect(res.status).toBe(200);
    expect(resData<UserStatusDto>(res).status).toBe('ACTIVE');

    const restored = await request(app).get(api('/auth/me')).set(auth(w.otherBuyer.token));
    expect(restored.status).toBe(200);
  });

  it('refuses to suspend an already-suspended account', async () => {
    await prisma.user.update({ where: { id: w.otherBuyer.id }, data: { status: 'SUSPENDED' } });
    const res = await request(app)
      .post(api(`/admin/users/${w.otherBuyer.id}/suspend`))
      .set(auth(w.admin.token))
      .send({ reason: 'Trying again.' });
    expect(res.status).toBe(409);
  });

  it('refuses to reinstate an account that is not suspended', async () => {
    const res = await request(app)
      .post(api(`/admin/users/${w.otherBuyer.id}/reinstate`))
      .set(auth(w.admin.token));
    expect(res.status).toBe(409);
  });

  it('refuses an admin suspending their own account', async () => {
    const res = await request(app)
      .post(api(`/admin/users/${w.admin.id}/suspend`))
      .set(auth(w.admin.token))
      .send({ reason: 'Testing.' });
    expect(res.status).toBe(409);
  });

  it('a non-admin cannot suspend anyone', async () => {
    const res = await request(app)
      .post(api(`/admin/users/${w.otherBuyer.id}/suspend`))
      .set(auth(w.buyer.token))
      .send({ reason: 'Trying anyway.' });
    expect(res.status).toBe(403);
  });

  it('GET /admin/users reports current status', async () => {
    await prisma.user.update({ where: { id: w.otherBuyer.id }, data: { status: 'SUSPENDED' } });
    const res = await request(app)
      .get(api(`/admin/users?search=${encodeURIComponent(w.otherBuyer.email)}`))
      .set(auth(w.admin.token));
    expect(res.status).toBe(200);
    const found = resData<Paginated<UserDirectoryEntry>>(res).items.find(
      (u) => u.userId === w.otherBuyer.id,
    );
    expect(found?.status).toBe('SUSPENDED');
  });
});
