/**
 * BV-018 step 3: anonymise-in-place, both the self-service route (POST /auth/delete-account)
 * and the admin route (POST /admin/users/{userId}/anonymize) share the same guard and the
 * same anonymize logic in services/account.service.ts. Tests here focus on that shared
 * behaviour; routes.conformance.test.ts and authz.test.ts cover the HTTP-layer conformance
 * and authorization matrix.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mail = vi.hoisted(() => ({
  send: vi.fn(async (_message: { subject: string; html: string }) => ({
    data: { id: 'email_test' },
    error: null,
  })),
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mail.send };
  },
}));

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { seedWorld, PASSWORD } = await import('./helpers/world.js');
const { checkAccountDeletable } = await import('../src/services/account.service.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let w: World;

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  w = await seedWorld();
  mail.send.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

describe('checkAccountDeletable', () => {
  it('refuses a seller with an active auction', async () => {
    const result = await checkAccountDeletable(w.seller.id);
    expect(result).toEqual({ allowed: false, reason: expect.stringMatching(/active auction/i) });
  });

  it('refuses a buyer with a pending transaction', async () => {
    const result = await checkAccountDeletable(w.buyer.id);
    expect(result).toEqual({ allowed: false, reason: expect.stringMatching(/awaiting payment/i) });
  });

  it('allows a user with no active auction and no pending transaction', async () => {
    // otherBuyer's only transaction (otherTransaction) is COMPLETED, not PENDING.
    const result = await checkAccountDeletable(w.otherBuyer.id);
    expect(result).toEqual({ allowed: true });
  });
});

describe('POST /auth/delete-account', () => {
  it('refuses the wrong password without touching the account', async () => {
    const res = await request(app)
      .post(api('/auth/delete-account'))
      .set(auth(w.otherBuyer.token))
      .send({ password: 'not-the-real-password' });

    expect(res.status).toBe(422);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: w.otherBuyer.id } });
    expect(row.email).toBe(w.otherBuyer.email);
  });

  it('refuses while the caller has an active auction or a pending transaction', async () => {
    const asSeller = await request(app)
      .post(api('/auth/delete-account'))
      .set(auth(w.seller.token))
      .send({ password: PASSWORD });
    expect(asSeller.status).toBe(409);

    const asBuyer = await request(app)
      .post(api('/auth/delete-account'))
      .set(auth(w.buyer.token))
      .send({ password: PASSWORD });
    expect(asBuyer.status).toBe(409);
  });

  it('anonymises the account, revokes every session, and emails the original address', async () => {
    const res = await request(app)
      .post(api('/auth/delete-account'))
      .set(auth(w.otherBuyer.token))
      .send({ password: PASSWORD });

    expect(res.status).toBe(200);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: w.otherBuyer.id } });
    expect(row.name).toBe('Deleted User');
    expect(row.email).toBe(`deleted-${w.otherBuyer.id}@bidvault.invalid`);

    const tokens = await prisma.refreshToken.findMany({ where: { userId: w.otherBuyer.id } });
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

    // The address that no longer exists on the row by the time this assertion runs.
    await vi.waitFor(() => {
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: w.otherBuyer.email, subject: 'Your BidVault account has been deleted' }),
      );
    });
  });

  it('the account can no longer log in afterward', async () => {
    await request(app)
      .post(api('/auth/delete-account'))
      .set(auth(w.otherBuyer.token))
      .send({ password: PASSWORD });

    const login = await request(app)
      .post(api('/auth/login'))
      .send({ email: w.otherBuyer.email, password: PASSWORD });

    expect(login.status).toBe(401);
  });
});

describe('POST /admin/users/:userId/anonymize', () => {
  it('requires a reason', async () => {
    const res = await request(app)
      .post(api(`/admin/users/${w.otherSeller.id}/anonymize`))
      .set(auth(w.admin.token))
      .send({});
    expect(res.status).toBe(400);
  });

  it('refuses a user with an active auction or a pending transaction', async () => {
    const res = await request(app)
      .post(api(`/admin/users/${w.seller.id}/anonymize`))
      .set(auth(w.admin.token))
      .send({ reason: 'Support request.' });
    expect(res.status).toBe(409);
  });

  it('anonymises the target and records the reason in the audit log', async () => {
    const res = await request(app)
      .post(api(`/admin/users/${w.otherSeller.id}/anonymize`))
      .set(auth(w.admin.token))
      .send({ reason: 'Requested via privacy@bidvault.com ticket #42.' });

    expect(res.status).toBe(200);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: w.otherSeller.id } });
    expect(row.name).toBe('Deleted User');

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'User', entityId: w.otherSeller.id, action: 'USER_ANONYMIZED' },
    });
    expect(entry.actorUserId).toBe(w.admin.id);
    expect(entry.metadata).toMatchObject({ reason: 'Requested via privacy@bidvault.com ticket #42.' });
  });
});

describe('GET /admin/users', () => {
  it('finds a user by a partial, case-insensitive email match', async () => {
    const res = await request(app)
      .get(api(`/admin/users?email=${encodeURIComponent(w.otherBuyer.email.toUpperCase().slice(0, 6))}`))
      .set(auth(w.admin.token));

    expect(res.status).toBe(200);
    expect(res.body.data.some((u: { userId: string }) => u.userId === w.otherBuyer.id)).toBe(true);
  });
});
