/**
 * BV-025: getPlatformSettings() used to be `upsert` on every cache miss -- a write on the
 * read path, with a thundering-herd shape under concurrent misses and no cross-process
 * coherence (a settings PUT only cleared the cache of whichever process served it). These
 * test the three things the fix actually changed: a miss reads without writing, concurrent
 * misses share one query, and a write anywhere is visible to this process before the TTL
 * would otherwise expire.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma } = await import('../src/db/prisma.js');
const {
  redisConnection,
  getSettingsPublishRedis,
  getSettingsSubscribeRedis,
  SETTINGS_INVALIDATE_CHANNEL,
} = await import('../src/infra/redis.js');
const { seedWorld } = await import('./helpers/world.js');
const {
  getPlatformSettings,
  updatePlatformSettings,
  subscribeToSettingsInvalidation,
} = await import('../src/services/settings.service.js');

beforeEach(async () => {
  // Truncates PlatformSetting along with everything else, and calls invalidateSettingsCache()
  // -- without the latter this file's module-scope cache would still hold the previous test's
  // value for up to 10s, which would make the single-flight assertion below see zero queries
  // instead of exactly one.
  await seedWorld();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
  getSettingsPublishRedis().disconnect();
  getSettingsSubscribeRedis().disconnect();
});

describe('getPlatformSettings', () => {
  it('returns defaults without creating a row when the singleton is missing', async () => {
    const settings = await getPlatformSettings();
    expect(settings).toEqual({
      emailNotifsEnabled: true,
      maintenanceMode: false,
      maxBidIncrement: 500_000,
      minListingPrice: 1_000,
      reviewTimeoutHours: 48,
      supportEmail: 'support@bidvault.tech',
    });

    const row = await prisma.platformSetting.findUnique({ where: { id: 'singleton' } });
    expect(row).toBeNull();
  });

  it('shares one query across concurrent cache misses (single-flight)', async () => {
    const spy = vi.spyOn(prisma.platformSetting, 'findUnique');

    const [a, b, c] = await Promise.all([
      getPlatformSettings(),
      getPlatformSettings(),
      getPlatformSettings(),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    spy.mockRestore();
  });
});

describe('cross-process invalidation', () => {
  it('picks up a write published from elsewhere, without waiting for the TTL', async () => {
    await subscribeToSettingsInvalidation();
    await getPlatformSettings(); // primes this process's cache with the pre-write value

    // Simulate a write from a DIFFERENT process: change the row directly, bypassing this
    // process's cache, then publish exactly as updatePlatformSettings does.
    await prisma.platformSetting.upsert({
      where: { id: 'singleton' },
      update: { minListingPrice: 42_000 },
      create: { id: 'singleton', minListingPrice: 42_000 },
    });
    await getSettingsPublishRedis().publish(SETTINGS_INVALIDATE_CHANNEL, '1');

    // 5s rather than the 1s default: a real Redis pub/sub round trip plus a DB read can
    // outrun vi.waitFor's default under a loaded CI runner.
    await vi.waitFor(async () => {
      const settings = await getPlatformSettings();
      expect(settings.minListingPrice).toBe(42_000);
    }, 5000);
  });
});

describe('updatePlatformSettings', () => {
  it('publishes an invalidation so every subscribed process drops its stale cache', async () => {
    const publishSpy = vi.spyOn(getSettingsPublishRedis(), 'publish');

    await updatePlatformSettings({ minListingPrice: 7_000 });

    expect(publishSpy).toHaveBeenCalledWith(SETTINGS_INVALIDATE_CHANNEL, '1');
    publishSpy.mockRestore();
  });
});
