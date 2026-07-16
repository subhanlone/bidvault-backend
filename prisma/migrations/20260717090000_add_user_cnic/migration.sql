-- Adds the CNIC (national ID) field to User, required at the application layer
-- for new registrations. Nullable at the DB level so existing rows are unaffected.
-- Idempotent (IF NOT EXISTS) so it is safe on both a db-pushed production
-- database and a fresh database applying the full migration history.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "cnic" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "User_cnic_key" ON "User"("cnic");
