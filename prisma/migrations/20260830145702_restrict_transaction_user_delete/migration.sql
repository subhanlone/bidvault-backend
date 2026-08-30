-- BV-018: AuctionTransaction.winnerId/sellerId were ON DELETE CASCADE, so deleting a User
-- would silently take their financial history with them. There is no account-deletion route
-- yet, but the moment one exists it can only be anonymise-in-place -- clear the PII fields,
-- keep the row -- because this constraint refuses to let a User with transaction history be
-- removed at all.

-- DropForeignKey
ALTER TABLE "AuctionTransaction" DROP CONSTRAINT "AuctionTransaction_sellerId_fkey";

-- DropForeignKey
ALTER TABLE "AuctionTransaction" DROP CONSTRAINT "AuctionTransaction_winnerId_fkey";

-- AddForeignKey
ALTER TABLE "AuctionTransaction" ADD CONSTRAINT "AuctionTransaction_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionTransaction" ADD CONSTRAINT "AuctionTransaction_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
