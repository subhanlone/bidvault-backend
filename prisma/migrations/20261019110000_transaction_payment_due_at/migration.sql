-- AlterTable
ALTER TABLE "AuctionTransaction" ADD COLUMN IF NOT EXISTS "paymentDueAt" TIMESTAMP(3);
