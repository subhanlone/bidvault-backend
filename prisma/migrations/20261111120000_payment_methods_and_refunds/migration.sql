-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'JAZZCASH', 'EASYPAISA', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('NOT_SHIPPED_SELLER', 'NOT_SHIPPED_ADMIN', 'NOT_SHIPPED_AUTO', 'DISPUTE_UPHELD', 'LISTING_TAKEN_DOWN');

-- CreateEnum
CREATE TYPE "RefundedBy" AS ENUM ('SELLER', 'ADMIN', 'SYSTEM');

-- AlterTable
ALTER TABLE "AuctionTransaction" ADD COLUMN     "bankTransferReference" TEXT,
ADD COLUMN     "paymentAccountHint" TEXT,
ADD COLUMN     "paymentMethod" "PaymentMethod",
ADD COLUMN     "refundNote" TEXT,
ADD COLUMN     "refundReason" "RefundReason",
ADD COLUMN     "refundReference" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3),
ADD COLUMN     "refundedBy" "RefundedBy";

-- CreateIndex
CREATE UNIQUE INDEX "AuctionTransaction_refundReference_key" ON "AuctionTransaction"("refundReference");

