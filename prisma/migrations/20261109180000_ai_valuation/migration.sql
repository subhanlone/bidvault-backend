-- Agentic AI valuation: one estimate per auction, and the admin-set USD to PKR rate. Generated with
-- `prisma migrate diff` against a shadow database, then made idempotent by hand like the earlier
-- migrations (enum and constraint creation in DO blocks, IF NOT EXISTS elsewhere).

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AiValuationStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'INSUFFICIENT_DATA', 'FAILED', 'PAUSED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "PlatformSetting" ADD COLUMN IF NOT EXISTS "usdToPkrRate" DOUBLE PRECISION NOT NULL DEFAULT 280;

-- CreateTable
CREATE TABLE IF NOT EXISTS "AiValuation" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "status" "AiValuationStatus" NOT NULL DEFAULT 'QUEUED',
    "averagePricePkr" INTEGER,
    "listingsUsed" INTEGER,
    "listingsConsidered" INTEGER,
    "source" TEXT,
    "errorMessage" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "computedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiValuation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AiValuation_auctionId_key" ON "AiValuation"("auctionId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "AiValuation" ADD CONSTRAINT "AiValuation_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
