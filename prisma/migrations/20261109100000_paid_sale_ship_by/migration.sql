-- FR-02: a paid sale the seller never ships gets a way out (docs/FR-02-PAID-SALE-EXIT-DESIGN.md).
-- Generated with `prisma migrate diff`; IF NOT EXISTS added by hand, as every migration here has,
-- because a database maintained with `db push` may already carry the columns.
-- No backfill: a sale paid before this has a null shipByAt, and readers work it out from paidAt.

-- AlterTable
ALTER TABLE "AuctionTransaction" ADD COLUMN IF NOT EXISTS "notShippedNote" TEXT,
ADD COLUMN IF NOT EXISTS "notShippedReportedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "shipByAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PlatformSetting" ADD COLUMN IF NOT EXISTS "shipByHours" INTEGER NOT NULL DEFAULT 72;
