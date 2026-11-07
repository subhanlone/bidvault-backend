-- CreateIndex
CREATE INDEX "Auction_status_currentBid_id_idx" ON "Auction"("status", "currentBid", "id");

-- CreateIndex
CREATE INDEX "Auction_status_bidCount_id_idx" ON "Auction"("status", "bidCount", "id");

-- CreateIndex
CREATE INDEX "Auction_status_createdAt_id_idx" ON "Auction"("status", "createdAt", "id");

