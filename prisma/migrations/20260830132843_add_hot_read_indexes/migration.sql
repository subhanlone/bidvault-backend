-- BV-017: nine indexes for the reads that scan the most rows as data grows (four of them are
-- the pagination targets in BV-029, which is why this lands first).
--
-- CONCURRENTLY was tried and dropped: Prisma wraps every migration in a transaction, and
-- Postgres refuses CREATE INDEX CONCURRENTLY inside one — confirmed empirically against a
-- throwaway database via the real `migrate deploy` path, not assumed. There is no clean way
-- to keep it without moving this migration outside Prisma's normal history (a manual DDL run
-- plus `migrate resolve --applied`), which trades a moment's table lock for a step someone
-- can forget. Given this project's actual scale, the lock is the safer trade. IF NOT EXISTS
-- because this environment is otherwise `db push`-maintained (see feedback-prisma-migration),
-- so a target database may already carry an index this file also tries to create.
--
-- RefreshToken(userId) is not here: it already exists (see the init migration).

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Auction_status_endTime_idx" ON "Auction"("status", "endTime");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Auction_sellerId_idx" ON "Auction"("sellerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuctionTransaction_sellerId_status_idx" ON "AuctionTransaction"("sellerId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuctionTransaction_winnerId_idx" ON "AuctionTransaction"("winnerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Listing_status_submittedAt_idx" ON "Listing"("status", "submittedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Listing_sellerId_submittedAt_idx" ON "Listing"("sellerId", "submittedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Watchlist_auctionId_idx" ON "Watchlist"("auctionId");
