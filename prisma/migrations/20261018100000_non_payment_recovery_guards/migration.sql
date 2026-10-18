-- AlterTable
ALTER TABLE "AuctionTransaction" ADD COLUMN IF NOT EXISTS "previousWinnerIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "relistedFromId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Listing_relistedFromId_key" ON "Listing"("relistedFromId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Listing" ADD CONSTRAINT "Listing_relistedFromId_fkey" FOREIGN KEY ("relistedFromId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
