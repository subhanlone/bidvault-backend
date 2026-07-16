-- Adds category-specific attribute storage to Listing and Auction.
-- Idempotent (IF NOT EXISTS) so it is safe on both a db-pushed production
-- database and a fresh database applying the full migration history.

ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "attributes" JSONB;
ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "attributes" JSONB;
