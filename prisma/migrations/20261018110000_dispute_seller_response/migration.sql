-- AlterTable
ALTER TABLE "Dispute" ADD COLUMN IF NOT EXISTS "sellerRespondedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "sellerResponse" TEXT;
