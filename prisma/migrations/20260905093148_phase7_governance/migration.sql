-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterEnum
DO $$ BEGIN
  ALTER TYPE "ListingStatus" ADD VALUE IF NOT EXISTS 'REMOVED';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "PlatformSetting" ADD COLUMN IF NOT EXISTS "reviewEditWindowHours" INTEGER NOT NULL DEFAULT 72;

-- AlterTable
ALTER TABLE "SellerReview" ADD COLUMN IF NOT EXISTS "sellerReply" TEXT,
ADD COLUMN IF NOT EXISTS "sellerReplyAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';
