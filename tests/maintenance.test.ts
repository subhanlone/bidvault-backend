/**
 * Maintenance mode, which nothing tested.
 *
 * Written while verifying an unrelated change: the linter flagged `app.use(maintenanceGuard)`
 * as passing an async function where a void return was expected, and the fix routes it
 * through the same asyncHandler every route already uses. That is the middleware standing
 * between a maintenance toggle and the entire API, and no test covered either of its
 * branches — so a rewiring of it could not be verified except by reading.
 *
 * The guard's contract, from middleware/maintenance.ts:
 *   - off        -> everything passes
 *   - on         -> 503 with code MAINTENANCE for non-admins
 *   - on + admin -> passes
 *   - on         -> the exempt prefixes still pass, so an admin can sign in and switch it off
 *   - unreadable -> fails open, so a settings outage never locks everyone out
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { seedWorld } = await import('./helpers/world.js');
const { invalidateSettingsCache } = await import('../src/services/settings.service.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let w: World;

async function setMaintenance(on: boolean) {
  await prisma.platformSetting.upsert({
    where: { id: 'singleton' },
    update: { maintenanceMode: on },
    create: { id: 'singleton', maintenanceMode: on },
  });
  // The service caches the row for 10 seconds in module scope; without this the guard would
  // keep reading the pre-toggle value for most of the run.
  invalidateSettingsCache();
}

beforeAll(async () => {
  await prisma.$connect();
});
beforeEach(async () => {
  w = await seedWorld();
});
afterEach(async () => {
  await setMaintenance(false);
});
afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

describe('maintenance mode off', () => {
  it('lets an ordinary request through', async () => {
    await setMaintenance(false);
    const res = await request(app).get(api('/auctions'));
    expect(res.status).toBe(200);
  });
});

describe('maintenance mode on', () => {
  it('answers 503 with code MAINTENANCE for an anonymous caller', async () => {
    await setMaintenance(true);
    const res = await request(app).get(api('/auctions'));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, code: 'MAINTENANCE' });
  });

  it('answers 503 for an authenticated non-admin', async () => {
    await setMaintenance(true);
    const res = await request(app).get(api('/auctions')).set(bearer(w.buyer.token));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'MAINTENANCE' });
  });

  it('lets an admin through', async () => {
    await setMaintenance(true);
    const res = await request(app).get(api('/admin/analytics')).set(bearer(w.admin.token));
    expect(res.status).toBe(200);
  });

  it('keeps the exempt paths reachable, so an admin can sign in and switch it off', async () => {
    await setMaintenance(true);

    // The login screen needs these three before anyone has a token at all.
    for (const path of ['/health', '/settings/public', '/stats']) {
      const res = await request(app).get(api(path));
      expect(res.status, `${path} must stay reachable during maintenance`).toBe(200);
    }

    // And login itself, or the admin can never get in to turn it off.
    const login = await request(app)
      .post(api('/auth/login'))
      .send({ email: w.admin.email, password: 'test-password-123' });
    expect(login.status).toBe(200);
  });

  it('an expired or forged token is treated as non-admin, not as an error', async () => {
    await setMaintenance(true);
    const res = await request(app).get(api('/auctions')).set({ Authorization: 'Bearer not.a.real.token' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'MAINTENANCE' });
  });
});
