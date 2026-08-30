-- BV-018: a deleted buyer's bids used to cascade away with them, leaving Auction.bidCount and
-- currentBid pointing at rows that no longer existed -- closeAuction would then silently
-- re-award to a lower bidder with no record of why. Bid.buyerId is now nullable and SetNull
-- instead of Cascade: the bid row survives with its owner cleared, so those columns stay
-- accurate regardless of what later happens to the account. There is no account-deletion route
-- yet for this to be exercised by; see the comment on the User model in schema.prisma.

-- DropForeignKey
ALTER TABLE "Bid" DROP CONSTRAINT "Bid_buyerId_fkey";

-- AlterTable
ALTER TABLE "Bid" ALTER COLUMN "buyerId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
