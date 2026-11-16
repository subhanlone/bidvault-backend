/**
 * POST /auth/forgot-password must not reveal whether an address is registered (FP-01; found
 * failing by the Part II report's test case TC8). The reply for a registered address and for an
 * unknown one must be the same: the same status, the same message and the same fields. Only the
 * development-only `resetCode` may differ, and production never sends it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resData } from './helpers/api.js';

vi.mock('../src/services/email.service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/email.service.js')>(
    '../src/services/email.service.js',
  );
  return { ...actual, sendPasswordResetEmail: vi.fn(() => Promise.resolve()) };
});

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { seedWorld } = await import('./helpers/world.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

const app = createApp();
const forgot = (email: string) => request(app).post('/api/v1/auth/forgot-password').send({ email });

/** The reply's data without the development-only code, which production never sends. */
function publicPart(res: { body: unknown }) {
  const { resetCode: _devOnly, ...rest } = resData<Record<string, unknown>>(res);
  return rest;
}

let w: World;

beforeAll(async () => {
  await prisma.$connect();
});
beforeEach(async () => {
  w = await seedWorld();
});
afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

describe('forgot-password does not reveal whether an account exists', () => {
  it('answers a registered and an unknown address exactly alike', async () => {
    const known = await forgot(w.buyer.email);
    const unknown = await forgot('nobody-here@test.local');

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(publicPart(known)).toEqual(publicPart(unknown));
  });

  it('still issues a reset code to the registered address', async () => {
    await forgot(w.buyer.email);
    const token = await prisma.passwordResetToken.findFirst({ where: { userId: w.buyer.id, consumedAt: null } });
    expect(token).not.toBeNull();
  });
});
