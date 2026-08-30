import { prisma } from '../db/prisma.js';
import {
  SETTINGS_INVALIDATE_CHANNEL,
  getSettingsPublishRedis,
  getSettingsSubscribeRedis,
} from '../infra/redis.js';

const SINGLETON_ID = 'singleton';
const TTL_MS = 10_000;

export interface PlatformSettingsData {
  emailNotifsEnabled: boolean;
  maintenanceMode: boolean;
  maxBidIncrement: number;
  minListingPrice: number;
  reviewTimeoutHours: number;
  supportEmail: string;
}

// Mirrors prisma/schema.prisma's @default values for PlatformSetting. Returned in place of the
// singleton row when it doesn't exist yet, so a read never needs to write one into existence
// (BV-025). prisma/seed.ts creates the real row; this is only the in-memory fallback.
const DEFAULTS: PlatformSettingsData = {
  emailNotifsEnabled: true,
  maintenanceMode: false,
  maxBidIncrement: 500_000,
  minListingPrice: 1_000,
  reviewTimeoutHours: 48,
  supportEmail: 'support@bidvault.tech',
};

let cache: { data: PlatformSettingsData; at: number } | null = null;

// Single-flight guard: without it, every request that misses the cache at the same moment (the
// thundering-herd case the TTL creates every 10s under load) issues its own query against the
// same row. Storing the in-flight promise, not just the eventual value, lets concurrent misses
// share one query instead of serialising on the database.
let inflight: Promise<PlatformSettingsData> | null = null;

type SettingRow = {
  emailNotifsEnabled: boolean;
  maintenanceMode: boolean;
  maxBidIncrement: number;
  minListingPrice: number;
  reviewTimeoutHours: number;
  supportEmail: string;
};

function toData(row: SettingRow): PlatformSettingsData {
  return {
    emailNotifsEnabled: row.emailNotifsEnabled,
    maintenanceMode: row.maintenanceMode,
    maxBidIncrement: row.maxBidIncrement,
    minListingPrice: row.minListingPrice,
    reviewTimeoutHours: row.reviewTimeoutHours,
    supportEmail: row.supportEmail,
  };
}

async function fetchSettings(): Promise<PlatformSettingsData> {
  const row = await prisma.platformSetting.findUnique({ where: { id: SINGLETON_ID } });
  return row ? toData(row) : DEFAULTS;
}

/** Reads the singleton settings row, falling back to defaults if it doesn't exist yet. Cached for TTL_MS. */
export async function getPlatformSettings(): Promise<PlatformSettingsData> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;

  inflight = fetchSettings()
    .then((data) => {
      cache = { data, at: Date.now() };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function updatePlatformSettings(
  patch: Partial<PlatformSettingsData>,
): Promise<PlatformSettingsData> {
  const row = await prisma.platformSetting.upsert({
    where: { id: SINGLETON_ID },
    update: patch,
    create: { id: SINGLETON_ID, ...patch },
  });
  const data = toData(row);
  cache = { data, at: Date.now() };
  // Tell every other process to drop its stale copy instead of waiting out the TTL. Fire-and-
  // forget: a settings write must not hang the admin's request because Redis is briefly down.
  void getSettingsPublishRedis()
    .publish(SETTINGS_INVALIDATE_CHANNEL, '1')
    .catch((err: unknown) => console.error('[settings] invalidation publish failed', err));
  return data;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

let subscribed = false;

/**
 * Starts listening for other processes' settings writes. Call once at process startup
 * (server.ts, the lifecycle worker) — never from createApp()/app.ts, which is constructed
 * fresh in every test file and would otherwise open a real Redis subscriber per test run.
 *
 * Returns a promise so a test can await the subscription actually being live before it
 * publishes — a PUBLISH issued before SUBSCRIBE completes is simply never delivered, since
 * Redis pub/sub has no backlog. Production call sites fire this without awaiting it; nothing
 * there depends on the subscription being ready by any particular moment.
 */
export function subscribeToSettingsInvalidation(): Promise<void> {
  if (subscribed) return Promise.resolve();
  subscribed = true;

  const subscriber = getSettingsSubscribeRedis();
  subscriber.on('message', (channel: string) => {
    if (channel === SETTINGS_INVALIDATE_CHANNEL) invalidateSettingsCache();
  });
  return subscriber
    .subscribe(SETTINGS_INVALIDATE_CHANNEL)
    .then(() => undefined)
    .catch((err: unknown) => console.error('[settings] invalidation subscribe failed', err));
}
