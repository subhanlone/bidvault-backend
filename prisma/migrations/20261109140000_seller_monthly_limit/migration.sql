-- B5 PR 3a: a new seller's monthly limit (platform settings) and an admin's per-person override.
-- Generated with `prisma migrate diff` against a shadow database; IF NOT EXISTS added by hand, as in
-- the earlier migrations, since a database maintained with `db push` may already have the columns.

-- AlterTable
ALTER TABLE "PlatformSetting" ADD COLUMN IF NOT EXISTS "newSellerMonthlyItems" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN IF NOT EXISTS "newSellerMonthlyValue" INTEGER NOT NULL DEFAULT 150000,
ADD COLUMN IF NOT EXISTS "sellerGraduationSales" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sellerLimitOverrideItems" INTEGER,
ADD COLUMN IF NOT EXISTS "sellerLimitOverrideValue" INTEGER;
