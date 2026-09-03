-- BV-047: the post-payment half of a sale, absent entirely before this (LIFECYCLE-GAPS.md
-- A4/C5/E6) -- shipping, delivery confirmation, disputes, and the seller's Stripe Connect
-- payout account. deliveryAddress/deliveryPhone are a per-sale snapshot on AuctionTransaction
-- rather than a User-profile field, since different sales can reasonably ship to different
-- places. Dispute is one-per-transaction, reachable only once a sale has shipped.

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'RESOLVED_REFUNDED', 'RESOLVED_RELEASED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionStatus" ADD VALUE 'SHIPPED';
ALTER TYPE "TransactionStatus" ADD VALUE 'DELIVERED';
ALTER TYPE "TransactionStatus" ADD VALUE 'DISPUTED';
ALTER TYPE "TransactionStatus" ADD VALUE 'REFUNDED';

-- AlterTable
ALTER TABLE "AuctionTransaction" ADD COLUMN     "deliveryAddress" TEXT,
ADD COLUMN     "deliveryPhone" TEXT,
ADD COLUMN     "shippedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "stripeAccountId" TEXT,
ADD COLUMN     "stripeOnboardingComplete" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "raisedByUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedByUserId" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_transactionId_key" ON "Dispute"("transactionId");

-- CreateIndex
CREATE INDEX "Dispute_status_idx" ON "Dispute"("status");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeAccountId_key" ON "User"("stripeAccountId");

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "AuctionTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

