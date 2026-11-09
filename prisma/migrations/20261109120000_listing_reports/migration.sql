-- G5: Report listing. Generated with `prisma migrate diff` against a shadow database, then made
-- idempotent by hand (enum and constraint creation in DO blocks, IF NOT EXISTS elsewhere) like the
-- earlier migrations, since a database maintained with `db push` may already carry the objects.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ReportReason" AS ENUM ('PROHIBITED_ITEM', 'MISLEADING', 'COUNTERFEIT', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'ACTIONED', 'DISMISSED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ListingReport" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "note" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "ListingReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ListingReport_status_createdAt_idx" ON "ListingReport"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ListingReport_auctionId_reporterId_key" ON "ListingReport"("auctionId", "reporterId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ListingReport" ADD CONSTRAINT "ListingReport_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ListingReport" ADD CONSTRAINT "ListingReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ListingReport" ADD CONSTRAINT "ListingReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
