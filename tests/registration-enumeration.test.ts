/**
 * POST /auth/register and POST /auth/resend-verification must not reveal whether an address has
 * an account (2026-11-18; the same class of leak report test case TC8 found in forgot-password).
 * Every address gets the same status, message and fields; only the development-only code may
 * differ, and production never sends it. What differs is the email: a new address gets its code,
 * an unverified account a fresh code, a verified account a note that it already exists.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resData } from './helpers/api.js';

vi.mock('../src/services/email.service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/email.service.js')>(
    '../src/services/email.service.js',
  );
  return {
    ...actual,
    sendWelcomeEmail: vi.fn(() => Promise.resolve()),
    sendVerificationResentEmail: vi.fn(() => Promise.resolve()),
    sendAccountExistsEmail: vi.fn(() => Promise.resolve()),
  };
});

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { takeViolations } = await import('../src/middleware/response-contract.js');
const { seedWorld } = await import('./helpers/world.js');
const email = await import('../src/services/email.service.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const register = (address: string, password = 'Another-Good-Password-1') =>
  request(app).post(api('/auth/register')).send({ name: 'Somebody', email: address, password });
const resend = (address: string) => request(app).post(api('/auth/resend-verification')).send({ email: address });

/** The reply without the development-only code, which production never sends, and the clock. */
function publicPart(res: { body: unknown }) {
  const { verificationCode: _devOnly, codeExpiresAt, ...rest } = resData<Record<string, unknown>>(res);
  return { ...rest, hasExpiry: typeof codeExpiresAt === 'string' };
}

let w: World;

beforeAll(async () => {
  await prisma.$connect();
});
beforeEach(async () => {
  w = await seedWorld();
  vi.clearAllMocks();
  takeViolations();
});
afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

async function unverifiedAccount(address: string) {
  const res = await register(address, 'Original-Password-1');
  expect(res.status).toBe(201);
  vi.clearAllMocks();
  return prisma.user.findUniqueOrThrow({ where: { email: address } });
}

describe('registration does not reveal whether an account exists', () => {
  it('answers a new, an unverified and a verified address exactly alike', async () => {
    await unverifiedAccount('pending@test.local');

    const fresh = await register('brand-new@test.local');
    const pending = await register('pending@test.local');
    const verified = await register(w.buyer.email);

    for (const res of [fresh, pending, verified]) expect(res.status).toBe(201);
    expect(publicPart(pending)).toEqual(publicPart(fresh));
    expect(publicPart(verified)).toEqual(publicPart(fresh));
    expect(publicPart(fresh)).toEqual({ message: 'Check your email for a verification code.', hasExpiry: true });
    expect(JSON.stringify(verified.body)).not.toContain(w.buyer.id);
    expect(takeViolations()).toEqual([]);
  });

  it('a verified account: no new account, its password unchanged, and its owner is told', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { email: w.buyer.email } });
    await register(w.buyer.email, 'Attacker-Chosen-Password-1');

    expect(await prisma.user.count({ where: { email: w.buyer.email } })).toBe(1);
    const after = await prisma.user.findUniqueOrThrow({ where: { email: w.buyer.email } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.name).toBe(before.name);
    expect(email.sendAccountExistsEmail).toHaveBeenCalledWith({ email: w.buyer.email, name: before.name });
    expect(email.sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it('an unverified account: its owner gets a fresh code, and its password stays the original', async () => {
    const user = await unverifiedAccount('pending@test.local');
    const oldToken = await prisma.emailVerificationToken.findFirstOrThrow({ where: { userId: user.id, consumedAt: null } });

    await register('pending@test.local', 'Someone-Elses-Password-1');

    const tokens = await prisma.emailVerificationToken.findMany({ where: { userId: user.id, consumedAt: null } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].id).not.toBe(oldToken.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(user.passwordHash);
    expect(email.sendVerificationResentEmail).toHaveBeenCalledTimes(1);
    expect(email.sendAccountExistsEmail).not.toHaveBeenCalled();
  });

  it('a new address still creates the account and sends its code', async () => {
    await register('brand-new@test.local');
    const row = await prisma.user.findUniqueOrThrow({ where: { email: 'brand-new@test.local' } });
    expect(row.isEmailVerified).toBe(false);
    expect(email.sendWelcomeEmail).toHaveBeenCalledTimes(1);
  });
});

describe('resend-verification does not reveal whether an account exists', () => {
  it('answers an unknown, a verified and an unverified address exactly alike', async () => {
    await unverifiedAccount('pending@test.local');

    const unknown = await resend('nobody-here@test.local');
    const verified = await resend(w.buyer.email);
    const pending = await resend('pending@test.local');

    for (const res of [unknown, verified, pending]) expect(res.status).toBe(200);
    expect(publicPart(verified)).toEqual(publicPart(unknown));
    expect(publicPart(pending)).toEqual(publicPart(unknown));
    expect(publicPart(unknown)).toEqual({
      message: 'If that email is registered and not yet verified, a new code was sent.',
      hasExpiry: true,
    });
  });

  it('still sends the unverified account a new code, and nobody else anything', async () => {
    await unverifiedAccount('pending@test.local');
    await resend('nobody-here@test.local');
    await resend(w.buyer.email);
    expect(email.sendVerificationResentEmail).not.toHaveBeenCalled();

    await resend('pending@test.local');
    expect(email.sendVerificationResentEmail).toHaveBeenCalledTimes(1);
  });
});
