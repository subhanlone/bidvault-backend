-- BV-017: the search box's `contains ... mode: 'insensitive'` on title/description is an
-- unanchored ILIKE '%…%', which no B-tree index (including the ones added in
-- 20260830132843_add_hot_read_indexes) can serve -- confirmed with EXPLAIN, forcing sequential
-- scans off left the planner with no alternative at all. pg_trgm's GIN indexes are the only
-- structure that answers this pattern.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Auction_title_idx" ON "Auction" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Auction_description_idx" ON "Auction" USING GIN ("description" gin_trgm_ops);
