-- Records whether a closed auction met its reserve price.
--
-- reservePrice was collected, stored and displayed but never compared against
-- anything, so auctions closed below reserve anyway, declared a winner, and
-- created a payment obligation the seller had been told could not happen.
--
-- Deliberately a nullable flag rather than a new AuctionStatus value: every
-- existing `status = 'CLOSED'` check across both repos keeps its meaning, so
-- this cannot silently change behaviour anywhere it is not read.
--
--   NULL  = no reserve set, or not yet closed
--   TRUE  = closed at or above reserve (AuctionTransaction exists)
--   FALSE = closed below reserve (no transaction, nothing owed)
--
-- Idempotent (IF NOT EXISTS) so it is safe on both a db-pushed production
-- database and a fresh database applying the full migration history.

ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "reserveMet" BOOLEAN;
