/**
 * FR-15 (docs/FULL-REVIEW-2026-11-08.md): the admin Users screen could delete or suspend any
 * row, including the signed-in admin, another admin and an account already deleted; and
 * self-service delete-account let the only admin delete themselves.
 *
 * The rules now:
 *   - an administrator account cannot be deleted (anonymized) or suspended through the admin
 *     routes, whoever asks, the admin themselves included;
 *   - an account that is already deleted cannot be deleted or suspended again (both would
 *     e-mail a `.invalid` address and write a misleading audit row);
 *   - self-service delete-account refuses the last active administrator, under a lock, so two
 *     admins closing their accounts at the same time cannot leave the platform with none;
 *   - GET /admin/users says which rows are deleted, so the screen can stop offering actions.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { hash } from '@node-rs/bcrypt';
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
const { seedWorld, PASSWORD } = await import('./helpers/world.js');
const { signAccessToken } = await import('../src/utils/jwt.js');
const { anonymizeUser } = await import('../src/services/account.service.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

interface DirectoryRow {
  userId: string;
  deleted: boolean;
}

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let w: World;

async function makeAdmin(email: string) {
  const user = await prisma.user.create({
    data: {
      name: 'Second Admin',
      email,
      passwordHash: await hash(PASSWORD, 4),
      role: 'ADMIN',
      isEmailVerified: true,
    },
  });
  return { id: user.id, token: signAccessToken({ sub: user.id, role: 'ADMIN' }) };
}

const deleteOwnAccount = (token: string) =>
  request(app).post(api('/auth/delete-account')).set(auth(token)).send({ password: PASSWORD });

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

describe('admin delete (anonymize)', () => {
  it('refuses to delete another administrator', async () => {
    const other = await makeAdmin('admin-two@test.local');
    const res = await request(app)
      .post(api(`/admin/users/${other.id}/anonymize`))
      .set(auth(w.admin.token))
      .send({ reason: 'Testing the guard.' });

    expect(res.status).toBe(409);
    expect(resError(res).error).toMatch(/administrator/i);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
    expect(row.email).toBe('admin-two@test.local');
  });

  it('refuses an admin deleting their own account from the Users screen', async () => {
    const res = await request(app)
      .post(api(`/admin/users/${w.admin.id}/anonymize`))
      .set(auth(w.admin.token))
      .send({ reason: 'Testing the guard.' });

    expect(res.status).toBe(409);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: w.admin.id } });
    expect(row.email).toBe(w.admin.email);
  });

  it('refuses to delete an account that is already deleted', async () => {
    await anonymizeUser(w.otherBuyer.id);
    const res = await request(app)
      .post(api(`/admin/users/${w.otherBuyer.id}/anonymize`))
      .set(auth(w.admin.token))
      .send({ reason: 'Testing the guard.' });

    expect(res.status).toBe(409);
    expect(resError(res).error).toMatch(/already deleted/i);
    expect(await prisma.auditLog.count({ where: { action: 'USER_ANONYMIZED', entityId: w.otherBuyer.id } })).toBe(0);
  });
});

describe('admin suspend', () => {
  it('refuses to suspend another administrator', async () => {
    const other = await makeAdmin('admin-two@test.local');
    const res = await request(app)
      .post(api(`/admin/users/${other.id}/suspend`))
      .set(auth(w.admin.token))
      .send({ reason: 'Testing the guard.' });

    expect(res.status).toBe(409);
    expect(resError(res).error).toMatch(/administrator/i);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
    expect(row.status).toBe('ACTIVE');
  });

  it('refuses to suspend an account that is already deleted', async () => {
    await anonymizeUser(w.otherBuyer.id);
    const res = await request(app)
      .post(api(`/admin/users/${w.otherBuyer.id}/suspend`))
      .set(auth(w.admin.token))
      .send({ reason: 'Testing the guard.' });

    expect(res.status).toBe(409);
    expect(resError(res).error).toMatch(/already deleted/i);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: w.otherBuyer.id } });
    expect(row.status).toBe('ACTIVE');
  });
});

describe('GET /admin/users', () => {
  it('marks deleted accounts', async () => {
    await anonymizeUser(w.otherBuyer.id);
    const res = await request(app).get(api('/admin/users?limit=50')).set(auth(w.admin.token));

    expect(res.status).toBe(200);
    const rows = resData<Paginated<DirectoryRow>>(res).items;
    expect(rows.find((r) => r.userId === w.otherBuyer.id)?.deleted).toBe(true);
    expect(rows.find((r) => r.userId === w.buyer.id)?.deleted).toBe(false);
  });
});

describe('self-service delete-account for administrators', () => {
  it('refuses the only active administrator', async () => {
    const res = await deleteOwnAccount(w.admin.token);

    expect(res.status).toBe(409);
    expect(resError(res).error).toMatch(/only administrator/i);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: w.admin.id } });
    expect(row.email).toBe(w.admin.email);
  });

  it('allows an administrator to leave while another active one remains', async () => {
    await makeAdmin('admin-two@test.local');
    const res = await deleteOwnAccount(w.admin.token);

    expect(res.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: w.admin.id } });
    expect(row.email).toMatch(/@bidvault\.invalid$/);
  });

  it('does not count a suspended or deleted administrator as the one who remains', async () => {
    const suspended = await makeAdmin('admin-two@test.local');
    await prisma.user.update({ where: { id: suspended.id }, data: { status: 'SUSPENDED' } });
    const deleted = await makeAdmin('admin-three@test.local');
    await anonymizeUser(deleted.id);

    const res = await deleteOwnAccount(w.admin.token);
    expect(res.status).toBe(409);
  });

  it('two administrators leaving at the same time cannot leave none', async () => {
    const other = await makeAdmin('admin-two@test.local');
    const results = await Promise.all([deleteOwnAccount(w.admin.token), deleteOwnAccount(other.token)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const remaining = await prisma.user.count({
      where: { role: 'ADMIN', status: 'ACTIVE', NOT: { email: { endsWith: '@bidvault.invalid' } } },
    });
    expect(remaining).toBe(1);
  });
});

describe('register', () => {
  it('refuses an address on the reserved .invalid domain that deleted accounts use', async () => {
    const res = await request(app)
      .post(api('/auth/register'))
      .send({ name: 'Look Alike', email: 'deleted-x@bidvault.invalid', password: 'Correct-Horse-Battery-9' });

    expect(res.status).toBe(400);
    expect(await prisma.user.count({ where: { email: 'deleted-x@bidvault.invalid' } })).toBe(0);
  });
});
