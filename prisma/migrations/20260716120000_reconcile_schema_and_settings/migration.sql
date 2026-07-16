-- Catch-up migration: reconciles the committed migration history with the live schema.
--
-- The schema had drifted from migrations via `prisma db push` (SellerReview table, the
-- Bid[buyerId,createdAt] index, the AuctionTransaction[auctionId] unique, and a dropped
-- Listing.startAt column). This migration also introduces user notification preferences,
-- the platform settings table, and the Auction default-status change.
--
-- Every statement is idempotent (IF [NOT] EXISTS / duplicate_object guards) so
-- `prisma migrate deploy` is safe on BOTH:
--   * the existing production database (already db-pushed) — existing objects are skipped
--   * a fresh database (applied after the two prior migrations) — everything is created

-- ── Listing: startAt removed from the model ──────────────────────────────────
ALTER TABLE "Listing" DROP COLUMN IF EXISTS "startAt";

-- ── User: notification preferences ───────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notifyOutbid" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notifyWins" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notifyNews" BOOLEAN NOT NULL DEFAULT false;

-- ── Auction: launches ACTIVE on approval (was SCHEDULED) ─────────────────────
ALTER TABLE "Auction" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

-- ── Bid: index for a buyer's own bids (NEW-08) ──────────────────────────────
CREATE INDEX IF NOT EXISTS "Bid_buyerId_createdAt_idx" ON "Bid"("buyerId", "createdAt");

-- ── AuctionTransaction: one winner row per auction (NEW-07) ─────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "AuctionTransaction_auctionId_key" ON "AuctionTransaction"("auctionId");

-- ── SellerReview (added post-init via db push) ──────────────────────────────
CREATE TABLE IF NOT EXISTS "SellerReview" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerReview_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SellerReview_transactionId_key" ON "SellerReview"("transactionId");
CREATE INDEX IF NOT EXISTS "SellerReview_sellerId_createdAt_idx" ON "SellerReview"("sellerId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "AuctionTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "SellerReview" ADD CONSTRAINT "SellerReview_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── PlatformSetting (singleton row) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PlatformSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "emailNotifsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "maintenanceMode" BOOLEAN NOT NULL DEFAULT false,
    "maxBidIncrement" INTEGER NOT NULL DEFAULT 500000,
    "minListingPrice" INTEGER NOT NULL DEFAULT 1000,
    "reviewTimeoutHours" INTEGER NOT NULL DEFAULT 48,
    "supportEmail" TEXT NOT NULL DEFAULT 'support@bidvault.tech',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id")
);
