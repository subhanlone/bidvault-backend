import { prisma } from '../db/prisma.js';

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

let cache: { data: PlatformSettingsData; at: number } | null = null;

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

/** Reads the singleton settings row (creating it with defaults on first access). Cached for TTL_MS. */
export async function getPlatformSettings(): Promise<PlatformSettingsData> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const row = await prisma.platformSetting.upsert({
    where: { id: SINGLETON_ID },
    update: {},
    create: { id: SINGLETON_ID },
  });
  const data = toData(row);
  cache = { data, at: Date.now() };
  return data;
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
  return data;
}

export function invalidateSettingsCache(): void {
  cache = null;
}
