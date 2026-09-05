-- Stripe replaced end to end with a self-built, fully-simulated payment gateway (Stripe is
-- UAE-registered and does not support Pakistan; no real money ever moved through it). The
-- seller payout side becomes a local ledger (LedgerEntry + User.ledgerBalance) instead of a
-- Stripe Connect account.

-- DropIndex
DROP INDEX "AuctionTransaction_stripePaymentIntentId_key";

-- DropIndex
DROP INDEX "User_stripeAccountId_key";

-- AlterTable
ALTER TABLE "AuctionTransaction" DROP COLUMN "stripePaymentIntentId",
ADD COLUMN     "paymentReference" TEXT;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "stripeAccountId",
DROP COLUMN "stripeOnboardingComplete",
ADD COLUMN     "ledgerBalance" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_transactionId_key" ON "LedgerEntry"("transactionId");

-- CreateIndex
CREATE INDEX "LedgerEntry_sellerId_createdAt_idx" ON "LedgerEntry"("sellerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionTransaction_paymentReference_key" ON "AuctionTransaction"("paymentReference");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "AuctionTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

