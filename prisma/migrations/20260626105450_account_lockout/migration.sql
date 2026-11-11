-- AlterTable
ALTER TABLE "User" ADD COLUMN     "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "unlockCodeAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "unlockCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "unlockCodeHash" TEXT;
