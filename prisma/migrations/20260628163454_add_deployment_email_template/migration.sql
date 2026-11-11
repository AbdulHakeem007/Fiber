-- CreateTable
CREATE TABLE "DeploymentEmailTemplate" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "module" TEXT NOT NULL DEFAULT 'TRACE_ROUTE',
    "toAlias" TEXT,
    "ccAlias" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "signature" TEXT,
    "attachTraceSheet" BOOLEAN NOT NULL DEFAULT true,
    "inlineCanvas" BOOLEAN NOT NULL DEFAULT true,
    "canvasMaxWidthPx" INTEGER NOT NULL DEFAULT 600,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentEmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentEmailTemplate_code_key" ON "DeploymentEmailTemplate"("code");
