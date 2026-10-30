-- B5: one account buys and sells. isSeller becomes the capability (read from the database on every
-- request), role stays as the legacy spelling. The seller* columns hold what a person gave when they
-- became a seller.

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "ageConfirmedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "isSeller" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "sellerBio" TEXT,
ADD COLUMN IF NOT EXISTS "sellerCity" TEXT,
ADD COLUMN IF NOT EXISTS "sellerPhone" TEXT,
ADD COLUMN IF NOT EXISTS "sellerProvince" TEXT,
ADD COLUMN IF NOT EXISTS "sellerSince" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "sellerTermsAcceptedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "sellerTermsVersion" TEXT;

-- Every account that was a seller before this change stays one, and is a seller since it was created.
UPDATE "User" SET "isSeller" = true, "sellerSince" = "createdAt" WHERE "role" = 'SELLER' AND "isSeller" = false;
