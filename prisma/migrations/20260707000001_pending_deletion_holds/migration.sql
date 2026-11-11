-- Delayed-deletion (24 working-hour soft-delete hold) ledger for ODF rows and
-- ODF Mapping segments. See prisma/schema.prisma model PendingDeletion.

-- CreateEnum
CREATE TYPE "PendingDeletionStatus" AS ENUM ('PENDING', 'CANCELLED', 'PURGED');

-- CreateEnum
CREATE TYPE "PendingDeletionEntityType" AS ENUM ('ODF', 'SEGMENT');

-- CreateTable
CREATE TABLE "PendingDeletion" (
    "id" TEXT NOT NULL,
    "entityType" "PendingDeletionEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityLabel" TEXT,
    "deleteGroupId" TEXT,
    "mergeTopology" BOOLEAN NOT NULL DEFAULT false,
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledPurgeAt" TIMESTAMP(3) NOT NULL,
    "status" "PendingDeletionStatus" NOT NULL DEFAULT 'PENDING',
    "cancelledAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "purgeError" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingDeletion_status_scheduledPurgeAt_idx" ON "PendingDeletion"("status", "scheduledPurgeAt");

-- CreateIndex
CREATE INDEX "PendingDeletion_entityType_entityId_status_idx" ON "PendingDeletion"("entityType", "entityId", "status");

-- CreateIndex
CREATE INDEX "PendingDeletion_deleteGroupId_idx" ON "PendingDeletion"("deleteGroupId");
