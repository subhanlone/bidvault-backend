-- BV-004 / BV-006: an admin's only way to give up on a transaction that will never be paid.
-- Reachable only from PENDING; a COMPLETED sale needs a refund (BV-047), not a void.

-- AlterEnum
ALTER TYPE "TransactionStatus" ADD VALUE 'VOIDED';
