-- B5 PR 3b: when an admin paused an account's selling. Generated with `prisma migrate diff` against a
-- shadow database; IF NOT EXISTS added by hand, as in the earlier migrations.

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sellerRevokedAt" TIMESTAMP(3);
