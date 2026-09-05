-- AlterEnum
BEGIN;
CREATE TYPE "AuctionStatus_new" AS ENUM ('ACTIVE', 'CLOSED', 'CANCELLED');
ALTER TABLE "public"."Auction" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Auction" ALTER COLUMN "status" TYPE "AuctionStatus_new" USING ("status"::text::"AuctionStatus_new");
ALTER TYPE "AuctionStatus" RENAME TO "AuctionStatus_old";
ALTER TYPE "AuctionStatus_new" RENAME TO "AuctionStatus";
DROP TYPE "public"."AuctionStatus_old";
ALTER TABLE "Auction" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
COMMIT;

-- AlterTable
ALTER TABLE "PlatformSetting" ADD COLUMN IF NOT EXISTS "paymentDeadlineHours" INTEGER NOT NULL DEFAULT 48;
