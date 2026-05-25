ALTER TABLE "AuctionTransaction" ADD COLUMN "stripePaymentIntentId" TEXT;
CREATE UNIQUE INDEX "AuctionTransaction_stripePaymentIntentId_key" ON "AuctionTransaction"("stripePaymentIntentId");
