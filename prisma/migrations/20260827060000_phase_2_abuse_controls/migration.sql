-- Generated mechanically with `prisma migrate diff` from the migration history to
-- prisma/schema.prisma. IF NOT EXISTS follows this repository's production convention:
-- development has historically used db push, so a column may already exist before the
-- migration history catches up.

-- AlterTable
ALTER TABLE "EmailVerificationToken"
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PasswordResetToken"
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RefreshToken_userId_idx" ON "RefreshToken"("userId");
