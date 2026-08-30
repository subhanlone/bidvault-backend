-- BV-042: the CNIC was collected only to enforce one-account-per-person and was never read
-- anywhere after registration -- never returned in any response, never used for KYC, dispute
-- resolution or payout compliance. Rather than hash or encrypt a value the product has no use
-- for, it is removed entirely: nothing left to leak, nothing left to decide how to protect.

-- DropIndex
DROP INDEX "User_cnic_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "cnic";
