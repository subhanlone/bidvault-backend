-- AlterTable
ALTER TABLE "AuctionTransaction" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);
