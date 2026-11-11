-- CreateEnum
CREATE TYPE "RoleCode" AS ENUM ('ADMIN', 'READ_WRITE', 'READ_ONLY');

-- CreateEnum
CREATE TYPE "LoginType" AS ENUM ('LOCAL', 'LDAP');

-- CreateEnum
CREATE TYPE "LoginMode" AS ENUM ('LOCAL_ONLY', 'LDAP_ONLY', 'LOCAL_AND_LDAP');

-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('ACTIVE', 'PLANNED', 'INACTIVE', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "OdfStatus" AS ENUM ('ACTIVE', 'PLANNED', 'INACTIVE', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "ResourceStatus" AS ENUM ('ACTIVE', 'AVAILABLE', 'USED', 'SPARE', 'RESERVED', 'FAULTY', 'DUMMY', 'PLANNED', 'UNKNOWN', 'MAINTENANCE', 'INACTIVE', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "PortGroupType" AS ENUM ('SINGLE', 'PAIR', 'CUSTOM');

-- CreateEnum
CREATE TYPE "EndpointSide" AS ENUM ('A', 'B');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('ACTIVE', 'PLANNED', 'SUSPENDED', 'PROTECTION', 'TEMPORARY', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "RouteType" AS ENUM ('WORKING', 'PROTECTION', 'TEMPORARY', 'RESTORATION');

-- CreateEnum
CREATE TYPE "MetricType" AS ENUM ('SEGMENT_UTILIZATION', 'SITE_PAIR_UTILIZATION', 'ODF_UTILIZATION', 'CABLE_UTILIZATION');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('HIGH_UTILIZATION', 'MISSING_FAR_END_MAPPING', 'MISSING_CABLE_INFORMATION', 'PARTIAL_TERMINATION', 'IMPORT_WARNING', 'DATA_GAP', 'DUPLICATE_MAPPING', 'FAULTY_FIBER_COUNT', 'CUTOVER_RISK', 'SINGLE_POINT_OF_FAILURE', 'SPUR_ENDPOINT_RISK', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertState" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'SUPPRESSED', 'CLEARED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS', 'MOBILE_PUSH', 'IN_APP', 'NONE');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('UPLOADED', 'VALIDATED', 'REVIEW_REQUIRED', 'COMMITTED', 'PARTIAL_FAILED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('STAGED', 'VALID', 'WARNING', 'ERROR', 'APPROVED', 'REJECTED', 'COMMITTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ChangeAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'IMPORT', 'EXPORT', 'RESERVE', 'RELEASE', 'ACKNOWLEDGE', 'SUPPRESS', 'CLEAR', 'PASSWORD_RESET', 'PASSWORD_CHANGE', 'SMTP_UPDATE', 'TEMPLATE_UPDATE', 'ROLE_CHANGE', 'MANUAL_OVERRIDE', 'LOGIN');

-- CreateEnum
CREATE TYPE "RecordSource" AS ENUM ('IMPORT', 'MANUAL', 'API', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SplitterScope" AS ENUM ('ISP', 'OSP');

-- CreateEnum
CREATE TYPE "SplitterProtection" AS ENUM ('PROTECTED', 'UNPROTECTED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "code" "RoleCode" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissionsJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "loginType" "LoginType" NOT NULL DEFAULT 'LOCAL',
    "passwordHash" TEXT,
    "passwordChangedAt" TIMESTAMP(3),
    "forcePasswordChange" BOOLEAN NOT NULL DEFAULT false,
    "roleId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSetting" (
    "id" TEXT NOT NULL,
    "loginMode" "LoginMode" NOT NULL DEFAULT 'LOCAL_ONLY',
    "ldapEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ldapHost" TEXT,
    "ldapPort" INTEGER,
    "ldapUseSsl" BOOLEAN NOT NULL DEFAULT true,
    "ldapBaseDn" TEXT,
    "ldapBindDn" TEXT,
    "ldapBindPasswordEnc" TEXT,
    "ldapUserDnPattern" TEXT,
    "ldapUserAttribute" TEXT DEFAULT 'sAMAccountName',
    "ldapAllowedUsernames" TEXT,
    "emergencyAccountEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emergencyUsername" TEXT NOT NULL DEFAULT 'portal.superadmin',
    "emergencyAllowedIps" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemporaryPassword" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemporaryPassword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "region" TEXT,
    "city" TEXT,
    "siteType" TEXT,
    "label" TEXT,
    "siteStructure" TEXT,
    "colocationType" TEXT,
    "colocationOwner" TEXT,
    "coordinateX" DOUBLE PRECISION,
    "coordinateY" DOUBLE PRECISION,
    "isFiberNode" BOOLEAN NOT NULL DEFAULT false,
    "isCoreSite" BOOLEAN NOT NULL DEFAULT false,
    "coreSiteType" TEXT,
    "isCriticalSite" BOOLEAN NOT NULL DEFAULT false,
    "isDatacenter" BOOLEAN NOT NULL DEFAULT false,
    "status" "SiteStatus" NOT NULL DEFAULT 'ACTIVE',
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteAlias" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "aliasNormalized" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "source" "RecordSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteCriticalityTag" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteCriticalityTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteCriticalityAssignment" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteCriticalityAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rack" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "rackCode" TEXT NOT NULL,
    "name" TEXT,
    "status" "OdfStatus" NOT NULL DEFAULT 'ACTIVE',
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ODF" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "rackId" TEXT NOT NULL,
    "odfCode" TEXT NOT NULL,
    "name" TEXT,
    "status" "OdfStatus" NOT NULL DEFAULT 'ACTIVE',
    "maxPorts" INTEGER,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ODF_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ODFPort" (
    "id" TEXT NOT NULL,
    "odfId" TEXT NOT NULL,
    "portNumber" INTEGER NOT NULL,
    "label" TEXT,
    "fiberPortNumber" INTEGER,
    "tubeNumber" INTEGER,
    "tubeColor" TEXT,
    "fiberNumber" INTEGER,
    "status" "ResourceStatus" NOT NULL DEFAULT 'AVAILABLE',
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ODFPort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortGroup" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "rackId" TEXT NOT NULL,
    "odfId" TEXT NOT NULL,
    "groupType" "PortGroupType" NOT NULL,
    "displayLabel" TEXT NOT NULL,
    "startPortNumber" INTEGER,
    "endPortNumber" INTEGER,
    "fiberPortNumber" INTEGER,
    "fiberNumber" INTEGER,
    "tubeNumber" INTEGER,
    "tubeColor" TEXT,
    "status" "ResourceStatus" NOT NULL DEFAULT 'AVAILABLE',
    "reservationNote" TEXT,
    "remarks" TEXT,
    "source" "RecordSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortGroupMember" (
    "id" TEXT NOT NULL,
    "portGroupId" TEXT NOT NULL,
    "odfPortId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cable" (
    "id" TEXT NOT NULL,
    "cableCode" TEXT,
    "cableName" TEXT,
    "cableType" TEXT,
    "totalFibers" INTEGER,
    "routeLabel" TEXT,
    "distanceKm" DOUBLE PRECISION,
    "siteAId" TEXT,
    "siteBId" TEXT,
    "status" "ResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SegmentEndpoint" (
    "id" TEXT NOT NULL,
    "endpointSide" "EndpointSide" NOT NULL,
    "siteId" TEXT,
    "rackId" TEXT,
    "odfId" TEXT,
    "portGroupId" TEXT,
    "rawSiteCode" TEXT,
    "rawRackCode" TEXT,
    "rawOdfCode" TEXT,
    "rawPortText" TEXT,
    "displayPortText" TEXT,
    "terminationStatus" "ResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SegmentEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkSegment" (
    "id" TEXT NOT NULL,
    "segmentCode" TEXT NOT NULL,
    "segmentGroupName" TEXT,
    "segmentSequence" TEXT,
    "segmentCapacityFibers" INTEGER,
    "sourceSegmentKey" TEXT,
    "sourceWorkbook" TEXT,
    "sourceWorksheetName" TEXT,
    "spanType" TEXT,
    "inventoryClass" TEXT,
    "matchStatus" TEXT,
    "sitePairKey" TEXT NOT NULL,
    "endpointAId" TEXT NOT NULL,
    "endpointBId" TEXT NOT NULL,
    "cableId" TEXT,
    "routeLabel" TEXT,
    "tubeNumber" INTEGER,
    "tubeColor" TEXT,
    "tubeLabel" TEXT,
    "fiberPortNumber" INTEGER,
    "fiberNumber" INTEGER,
    "fiberLabel" TEXT,
    "fiberCount" INTEGER,
    "totalFiberCapacity" INTEGER NOT NULL DEFAULT 0,
    "usableFiberCapacity" INTEGER,
    "usedFiberCount" INTEGER NOT NULL DEFAULT 0,
    "reservedFiberCount" INTEGER NOT NULL DEFAULT 0,
    "faultyFiberCount" INTEGER NOT NULL DEFAULT 0,
    "inactiveFiberCount" INTEGER NOT NULL DEFAULT 0,
    "dummyFiberCount" INTEGER NOT NULL DEFAULT 0,
    "availableFiberCount" INTEGER NOT NULL DEFAULT 0,
    "utilizationPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "terminatedPairCount" INTEGER,
    "distanceKm" DOUBLE PRECISION,
    "status" "ResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPartialTermination" BOOLEAN NOT NULL DEFAULT false,
    "isMirrorCandidate" BOOLEAN NOT NULL DEFAULT false,
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "comments" TEXT,
    "allocatedServiceCode" TEXT,
    "allocationNote" TEXT,
    "segmentDefaultRole" TEXT,
    "installedAt" TIMESTAMP(3),
    "decommissionedAt" TIMESTAMP(3),
    "source" "RecordSource" NOT NULL DEFAULT 'IMPORT',
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SegmentFiber" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "fiberNumber" INTEGER NOT NULL,
    "status" "ResourceStatus" NOT NULL DEFAULT 'AVAILABLE',
    "serviceId" TEXT,
    "serviceRouteId" TEXT,
    "serviceAllocationId" TEXT,
    "serviceCode" TEXT,
    "allocationGroup" TEXT,
    "pathOrder" INTEGER,
    "isJumper" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT,
    "tubeNumber" INTEGER,
    "tubeColor" TEXT,
    "tubeLabel" TEXT,
    "fiberPortNumber" INTEGER,
    "fiberLabel" TEXT,
    "allocatedAt" TIMESTAMP(3),
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SegmentFiber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SegmentEndpointMapping" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "importStagingRowId" TEXT,
    "localSiteCode" TEXT,
    "localRackCode" TEXT,
    "localOdfCode" TEXT,
    "localPortLabel" TEXT,
    "farSiteCode" TEXT,
    "farEndpointLabel" TEXT,
    "farRackCode" TEXT,
    "farOdfCode" TEXT,
    "farPortLabel" TEXT,
    "localPortGroupId" TEXT,
    "farPortGroupId" TEXT,
    "fiberNumbersJson" TEXT,
    "serviceCode" TEXT,
    "childTopologyRole" TEXT,
    "tag" TEXT,
    "jumperSiteCode" TEXT,
    "status" "ResourceStatus" NOT NULL DEFAULT 'AVAILABLE',
    "source" "RecordSource" NOT NULL DEFAULT 'IMPORT',
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SegmentEndpointMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "customerName" TEXT,
    "status" "ServiceStatus" NOT NULL DEFAULT 'ACTIVE',
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRoute" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "routeName" TEXT NOT NULL,
    "routeType" "RouteType" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "slaClass" TEXT,
    "protectionMode" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAllocation" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "serviceRouteId" TEXT,
    "segmentId" TEXT NOT NULL,
    "allocationGroup" TEXT NOT NULL,
    "pathOrder" INTEGER NOT NULL,
    "fromSiteId" TEXT,
    "toSiteId" TEXT,
    "endpointAId" TEXT,
    "endpointBId" TEXT,
    "endpointAPortGroupId" TEXT,
    "endpointBPortGroupId" TEXT,
    "fiberStart" INTEGER NOT NULL,
    "fiberEnd" INTEGER NOT NULL,
    "fiberNumbersJson" TEXT NOT NULL,
    "status" "ResourceStatus" NOT NULL DEFAULT 'USED',
    "isJumper" BOOLEAN NOT NULL DEFAULT false,
    "isProtection" BOOLEAN NOT NULL DEFAULT false,
    "pathLabel" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRouteHop" (
    "id" TEXT NOT NULL,
    "serviceRouteId" TEXT NOT NULL,
    "hopOrder" INTEGER NOT NULL,
    "siteId" TEXT,
    "rackId" TEXT,
    "odfId" TEXT,
    "portGroupId" TEXT,
    "segmentId" TEXT,
    "pathLabel" TEXT,
    "distanceKm" DOUBLE PRECISION,
    "isProtectionHop" BOOLEAN NOT NULL DEFAULT false,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceRouteHop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UtilizationMetric" (
    "id" TEXT NOT NULL,
    "metricType" "MetricType" NOT NULL,
    "scopeSegmentId" TEXT,
    "scopeSiteId" TEXT,
    "scopeOdfId" TEXT,
    "scopeCableId" TEXT,
    "sitePairKey" TEXT,
    "totalGroups" INTEGER NOT NULL DEFAULT 0,
    "usedGroups" INTEGER NOT NULL DEFAULT 0,
    "spareGroups" INTEGER NOT NULL DEFAULT 0,
    "reservedGroups" INTEGER NOT NULL DEFAULT 0,
    "faultyGroups" INTEGER NOT NULL DEFAULT 0,
    "utilizationPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "denominatorNote" TEXT,
    "calculationNote" TEXT,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "source" "RecordSource" NOT NULL DEFAULT 'SYSTEM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UtilizationMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertPolicy" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "alertType" "AlertType" NOT NULL,
    "metricType" "MetricType",
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "warningThresholdPct" DOUBLE PRECISION,
    "criticalThresholdPct" DOUBLE PRECISION,
    "consecutiveHits" INTEGER NOT NULL DEFAULT 1,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "hysteresisPct" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "notificationChannel" "NotificationChannel" NOT NULL DEFAULT 'EMAIL',
    "notifyEmails" TEXT,
    "allowManualSuppress" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertSuppression" (
    "id" TEXT NOT NULL,
    "alertPolicyId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "sitePairKey" TEXT,
    "reason" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "alertPolicyId" TEXT NOT NULL,
    "alertType" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "state" "AlertState" NOT NULL DEFAULT 'OPEN',
    "linkSegmentId" TEXT,
    "siteId" TEXT,
    "odfId" TEXT,
    "metricId" TEXT,
    "suppressionId" TEXT,
    "sitePairKey" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT,
    "hitCount" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationTemplate" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'EMAIL',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "placeholdersJson" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmtpConfiguration" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default SMTP',
    "host" TEXT,
    "port" INTEGER,
    "username" TEXT,
    "encryptedPassword" TEXT,
    "senderName" TEXT,
    "senderEmail" TEXT,
    "replyTo" TEXT,
    "encryptionType" TEXT NOT NULL DEFAULT 'STARTTLS',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastTestAt" TIMESTAMP(3),
    "lastTestStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmtpConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipientGroup" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipientGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipientGroupMember" (
    "id" TEXT NOT NULL,
    "recipientGroupId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipientGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "userId" TEXT,
    "alertEventId" TEXT,
    "metadataJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyReportSchedule" (
    "id" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dayOfWeek" INTEGER NOT NULL DEFAULT 1,
    "sendHour" INTEGER NOT NULL DEFAULT 7,
    "sendMinute" INTEGER NOT NULL DEFAULT 0,
    "warnThresholdPct" DOUBLE PRECISION,
    "critThresholdPct" DOUBLE PRECISION,
    "minNodes" INTEGER,
    "recipients" TEXT,
    "recipientGroupCode" TEXT,
    "includeConfigured" BOOLEAN NOT NULL DEFAULT false,
    "lastSentAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeeklyReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertDefinition" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "definition" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertDefinition_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "batchCode" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileChecksum" TEXT,
    "sourceSystem" TEXT,
    "templateVersion" TEXT,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'UPLOADED',
    "uploadedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "committedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "committedAt" TIMESTAMP(3),
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "warningRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "committedRows" INTEGER NOT NULL DEFAULT 0,
    "summaryText" TEXT,
    "comments" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportStagingRow" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'STAGED',
    "rawJson" TEXT NOT NULL,
    "normalizedJson" TEXT,
    "normalizedSiteAId" TEXT,
    "normalizedSiteBId" TEXT,
    "proposedSegmentCode" TEXT,
    "mirrorKey" TEXT,
    "rowHash" TEXT,
    "duplicateOfSegmentId" TEXT,
    "reviewerComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportStagingRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportIssue" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "stagingRowId" TEXT,
    "severity" "IssueSeverity" NOT NULL,
    "issueCode" TEXT NOT NULL,
    "fieldName" TEXT,
    "message" TEXT NOT NULL,
    "suggestedFix" TEXT,
    "blocking" BOOLEAN NOT NULL DEFAULT true,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Splitter" (
    "id" TEXT NOT NULL,
    "splitterCode" TEXT NOT NULL,
    "splitterName" TEXT,
    "splitterType" TEXT DEFAULT 'OSP_SPL',
    "scope" "SplitterScope" NOT NULL,
    "location" TEXT,
    "locationContext" TEXT,
    "handhole" TEXT,
    "cabinet" TEXT,
    "protectionMode" "SplitterProtection" NOT NULL DEFAULT 'UNKNOWN',
    "primaryInputSiteCode" TEXT,
    "primaryInputRackCode" TEXT,
    "primaryInputOdfCode" TEXT,
    "primaryInputPortLabel" TEXT,
    "secondaryInputSiteCode" TEXT,
    "secondaryInputRackCode" TEXT,
    "secondaryInputOdfCode" TEXT,
    "secondaryInputPortLabel" TEXT,
    "outputPortCapacity" INTEGER,
    "configuredOutputPorts" INTEGER NOT NULL DEFAULT 0,
    "status" "ResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "RecordSource" NOT NULL DEFAULT 'IMPORT',
    "importBatchId" TEXT,
    "sourceRowReferencesJson" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Splitter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SplitterOutput" (
    "id" TEXT NOT NULL,
    "splitterId" TEXT NOT NULL,
    "outputLabel" TEXT,
    "outputPort" TEXT,
    "localSiteCode" TEXT,
    "localRackCode" TEXT,
    "localOdfCode" TEXT,
    "localPortLabel" TEXT,
    "destinationSiteCode" TEXT,
    "destinationLabel" TEXT,
    "destinationRackCode" TEXT,
    "destinationOdfCode" TEXT,
    "destinationPortLabel" TEXT,
    "serviceCode" TEXT,
    "sharingCustomerServiceId" TEXT,
    "sharingCustomerServiceCode" TEXT,
    "capacityFibers" INTEGER NOT NULL DEFAULT 1,
    "usedFibers" INTEGER NOT NULL DEFAULT 0,
    "availableFibers" INTEGER NOT NULL DEFAULT 1,
    "status" "ResourceStatus" NOT NULL DEFAULT 'AVAILABLE',
    "portGroupId" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SplitterOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" "ChangeAction" NOT NULL,
    "fieldName" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "reason" TEXT,
    "comment" TEXT,
    "changedById" TEXT,
    "importBatchId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemChangeLog" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operatorId" TEXT,
    "actionType" TEXT NOT NULL,
    "targetTable" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "originalState" JSONB,
    "newState" JSONB,
    "batchId" TEXT,
    "revertedAt" TIMESTAMP(3),
    "revertedBy" TEXT,

    CONSTRAINT "SystemChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UtilizationHistory" (
    "id" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceTable" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "segmentName" TEXT,
    "siteId" TEXT,
    "rackId" TEXT,
    "odfId" TEXT,
    "totalFibers" INTEGER,
    "activeFibers" INTEGER,
    "availableFibers" INTEGER,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "UtilizationHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportMetadata" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storedPath" TEXT,
    "uploadedBy" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "batchId" TEXT,

    CONSTRAINT "ImportMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SegmentAttachment" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT,
    "siteId" TEXT,
    "documentType" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "storedFilename" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remarks" TEXT,

    CONSTRAINT "SegmentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_code_key" ON "Role"("code");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_code_key" ON "Permission"("code");

-- CreateIndex
CREATE INDEX "UserRole_roleId_idx" ON "UserRole"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_userId_roleId_key" ON "UserRole"("userId", "roleId");

-- CreateIndex
CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permissionId_key" ON "RolePermission"("roleId", "permissionId");

-- CreateIndex
CREATE INDEX "TemporaryPassword_userId_expiresAt_idx" ON "TemporaryPassword"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_expiresAt_idx" ON "PasswordResetToken"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Site_code_key" ON "Site"("code");

-- CreateIndex
CREATE INDEX "Site_region_idx" ON "Site"("region");

-- CreateIndex
CREATE INDEX "Site_siteType_idx" ON "Site"("siteType");

-- CreateIndex
CREATE INDEX "Site_label_idx" ON "Site"("label");

-- CreateIndex
CREATE INDEX "Site_colocationType_idx" ON "Site"("colocationType");

-- CreateIndex
CREATE INDEX "Site_isFiberNode_idx" ON "Site"("isFiberNode");

-- CreateIndex
CREATE INDEX "Site_isCoreSite_idx" ON "Site"("isCoreSite");

-- CreateIndex
CREATE INDEX "Site_coreSiteType_idx" ON "Site"("coreSiteType");

-- CreateIndex
CREATE INDEX "Site_isCriticalSite_idx" ON "Site"("isCriticalSite");

-- CreateIndex
CREATE INDEX "Site_isDatacenter_idx" ON "Site"("isDatacenter");

-- CreateIndex
CREATE INDEX "Site_status_idx" ON "Site"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SiteAlias_siteId_aliasNormalized_key" ON "SiteAlias"("siteId", "aliasNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "SiteAlias_aliasNormalized_key" ON "SiteAlias"("aliasNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "SiteCriticalityTag_code_key" ON "SiteCriticalityTag"("code");

-- CreateIndex
CREATE INDEX "SiteCriticalityAssignment_tagId_idx" ON "SiteCriticalityAssignment"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteCriticalityAssignment_siteId_tagId_key" ON "SiteCriticalityAssignment"("siteId", "tagId");

-- CreateIndex
CREATE INDEX "Rack_siteId_idx" ON "Rack"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Rack_siteId_rackCode_key" ON "Rack"("siteId", "rackCode");

-- CreateIndex
CREATE INDEX "ODF_siteId_odfCode_idx" ON "ODF"("siteId", "odfCode");

-- CreateIndex
CREATE INDEX "ODF_siteId_status_idx" ON "ODF"("siteId", "status");

-- CreateIndex
CREATE INDEX "ODF_rackId_status_idx" ON "ODF"("rackId", "status");

-- CreateIndex
CREATE INDEX "ODF_rackId_idx" ON "ODF"("rackId");

-- CreateIndex
CREATE UNIQUE INDEX "ODF_siteId_rackId_odfCode_key" ON "ODF"("siteId", "rackId", "odfCode");

-- CreateIndex
CREATE INDEX "ODFPort_status_idx" ON "ODFPort"("status");

-- CreateIndex
CREATE INDEX "ODFPort_odfId_status_idx" ON "ODFPort"("odfId", "status");

-- CreateIndex
CREATE INDEX "ODFPort_fiberPortNumber_idx" ON "ODFPort"("fiberPortNumber");

-- CreateIndex
CREATE INDEX "ODFPort_tubeNumber_idx" ON "ODFPort"("tubeNumber");

-- CreateIndex
CREATE INDEX "ODFPort_fiberNumber_idx" ON "ODFPort"("fiberNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ODFPort_odfId_portNumber_key" ON "ODFPort"("odfId", "portNumber");

-- CreateIndex
CREATE INDEX "PortGroup_siteId_idx" ON "PortGroup"("siteId");

-- CreateIndex
CREATE INDEX "PortGroup_rackId_idx" ON "PortGroup"("rackId");

-- CreateIndex
CREATE INDEX "PortGroup_status_idx" ON "PortGroup"("status");

-- CreateIndex
CREATE INDEX "PortGroup_odfId_status_idx" ON "PortGroup"("odfId", "status");

-- CreateIndex
CREATE INDEX "PortGroup_fiberPortNumber_idx" ON "PortGroup"("fiberPortNumber");

-- CreateIndex
CREATE INDEX "PortGroup_fiberNumber_idx" ON "PortGroup"("fiberNumber");

-- CreateIndex
CREATE INDEX "PortGroup_tubeNumber_idx" ON "PortGroup"("tubeNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PortGroup_odfId_displayLabel_key" ON "PortGroup"("odfId", "displayLabel");

-- CreateIndex
CREATE INDEX "PortGroupMember_odfPortId_idx" ON "PortGroupMember"("odfPortId");

-- CreateIndex
CREATE UNIQUE INDEX "PortGroupMember_portGroupId_odfPortId_key" ON "PortGroupMember"("portGroupId", "odfPortId");

-- CreateIndex
CREATE UNIQUE INDEX "PortGroupMember_portGroupId_sequence_key" ON "PortGroupMember"("portGroupId", "sequence");

-- CreateIndex
CREATE INDEX "Cable_cableCode_idx" ON "Cable"("cableCode");

-- CreateIndex
CREATE INDEX "Cable_siteAId_siteBId_idx" ON "Cable"("siteAId", "siteBId");

-- CreateIndex
CREATE INDEX "Cable_status_idx" ON "Cable"("status");

-- CreateIndex
CREATE INDEX "SegmentEndpoint_siteId_idx" ON "SegmentEndpoint"("siteId");

-- CreateIndex
CREATE INDEX "SegmentEndpoint_rackId_idx" ON "SegmentEndpoint"("rackId");

-- CreateIndex
CREATE INDEX "SegmentEndpoint_odfId_idx" ON "SegmentEndpoint"("odfId");

-- CreateIndex
CREATE INDEX "SegmentEndpoint_portGroupId_idx" ON "SegmentEndpoint"("portGroupId");

-- CreateIndex
CREATE INDEX "SegmentEndpoint_rawSiteCode_idx" ON "SegmentEndpoint"("rawSiteCode");

-- CreateIndex
CREATE UNIQUE INDEX "LinkSegment_segmentCode_key" ON "LinkSegment"("segmentCode");

-- CreateIndex
CREATE UNIQUE INDEX "LinkSegment_endpointAId_key" ON "LinkSegment"("endpointAId");

-- CreateIndex
CREATE UNIQUE INDEX "LinkSegment_endpointBId_key" ON "LinkSegment"("endpointBId");

-- CreateIndex
CREATE INDEX "LinkSegment_sitePairKey_idx" ON "LinkSegment"("sitePairKey");

-- CreateIndex
CREATE INDEX "LinkSegment_segmentGroupName_idx" ON "LinkSegment"("segmentGroupName");

-- CreateIndex
CREATE INDEX "LinkSegment_segmentSequence_idx" ON "LinkSegment"("segmentSequence");

-- CreateIndex
CREATE INDEX "LinkSegment_sourceSegmentKey_idx" ON "LinkSegment"("sourceSegmentKey");

-- CreateIndex
CREATE INDEX "LinkSegment_spanType_idx" ON "LinkSegment"("spanType");

-- CreateIndex
CREATE INDEX "LinkSegment_inventoryClass_idx" ON "LinkSegment"("inventoryClass");

-- CreateIndex
CREATE INDEX "LinkSegment_cableId_idx" ON "LinkSegment"("cableId");

-- CreateIndex
CREATE INDEX "LinkSegment_status_idx" ON "LinkSegment"("status");

-- CreateIndex
CREATE INDEX "LinkSegment_status_updatedAt_idx" ON "LinkSegment"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "LinkSegment_allocatedServiceCode_idx" ON "LinkSegment"("allocatedServiceCode");

-- CreateIndex
CREATE INDEX "LinkSegment_segmentDefaultRole_idx" ON "LinkSegment"("segmentDefaultRole");

-- CreateIndex
CREATE INDEX "LinkSegment_importBatchId_idx" ON "LinkSegment"("importBatchId");

-- CreateIndex
CREATE INDEX "SegmentFiber_segmentId_status_idx" ON "SegmentFiber"("segmentId", "status");

-- CreateIndex
CREATE INDEX "SegmentFiber_serviceCode_idx" ON "SegmentFiber"("serviceCode");

-- CreateIndex
CREATE INDEX "SegmentFiber_serviceId_idx" ON "SegmentFiber"("serviceId");

-- CreateIndex
CREATE INDEX "SegmentFiber_serviceRouteId_idx" ON "SegmentFiber"("serviceRouteId");

-- CreateIndex
CREATE INDEX "SegmentFiber_serviceAllocationId_idx" ON "SegmentFiber"("serviceAllocationId");

-- CreateIndex
CREATE INDEX "SegmentFiber_allocationGroup_idx" ON "SegmentFiber"("allocationGroup");

-- CreateIndex
CREATE UNIQUE INDEX "SegmentFiber_segmentId_fiberNumber_key" ON "SegmentFiber"("segmentId", "fiberNumber");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_segmentId_idx" ON "SegmentEndpointMapping"("segmentId");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_segmentId_status_idx" ON "SegmentEndpointMapping"("segmentId", "status");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_importStagingRowId_idx" ON "SegmentEndpointMapping"("importStagingRowId");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_serviceCode_idx" ON "SegmentEndpointMapping"("serviceCode");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_serviceCode_status_idx" ON "SegmentEndpointMapping"("serviceCode", "status");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_childTopologyRole_idx" ON "SegmentEndpointMapping"("childTopologyRole");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_tag_idx" ON "SegmentEndpointMapping"("tag");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_jumperSiteCode_idx" ON "SegmentEndpointMapping"("jumperSiteCode");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_localSiteCode_farSiteCode_idx" ON "SegmentEndpointMapping"("localSiteCode", "farSiteCode");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_localSiteCode_status_idx" ON "SegmentEndpointMapping"("localSiteCode", "status");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_farSiteCode_status_idx" ON "SegmentEndpointMapping"("farSiteCode", "status");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_localOdfCode_localPortLabel_idx" ON "SegmentEndpointMapping"("localOdfCode", "localPortLabel");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_farOdfCode_farPortLabel_idx" ON "SegmentEndpointMapping"("farOdfCode", "farPortLabel");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_localPortGroupId_idx" ON "SegmentEndpointMapping"("localPortGroupId");

-- CreateIndex
CREATE INDEX "SegmentEndpointMapping_farPortGroupId_idx" ON "SegmentEndpointMapping"("farPortGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_serviceCode_key" ON "Service"("serviceCode");

-- CreateIndex
CREATE INDEX "Service_serviceType_idx" ON "Service"("serviceType");

-- CreateIndex
CREATE INDEX "Service_status_idx" ON "Service"("status");

-- CreateIndex
CREATE INDEX "ServiceRoute_serviceId_routeType_idx" ON "ServiceRoute"("serviceId", "routeType");

-- CreateIndex
CREATE INDEX "ServiceRoute_isActive_idx" ON "ServiceRoute"("isActive");

-- CreateIndex
CREATE INDEX "ServiceAllocation_serviceId_idx" ON "ServiceAllocation"("serviceId");

-- CreateIndex
CREATE INDEX "ServiceAllocation_serviceRouteId_idx" ON "ServiceAllocation"("serviceRouteId");

-- CreateIndex
CREATE INDEX "ServiceAllocation_segmentId_idx" ON "ServiceAllocation"("segmentId");

-- CreateIndex
CREATE INDEX "ServiceAllocation_allocationGroup_idx" ON "ServiceAllocation"("allocationGroup");

-- CreateIndex
CREATE INDEX "ServiceAllocation_pathOrder_idx" ON "ServiceAllocation"("pathOrder");

-- CreateIndex
CREATE INDEX "ServiceAllocation_fromSiteId_toSiteId_idx" ON "ServiceAllocation"("fromSiteId", "toSiteId");

-- CreateIndex
CREATE INDEX "ServiceAllocation_status_idx" ON "ServiceAllocation"("status");

-- CreateIndex
CREATE INDEX "ServiceRouteHop_siteId_idx" ON "ServiceRouteHop"("siteId");

-- CreateIndex
CREATE INDEX "ServiceRouteHop_segmentId_idx" ON "ServiceRouteHop"("segmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRouteHop_serviceRouteId_hopOrder_key" ON "ServiceRouteHop"("serviceRouteId", "hopOrder");

-- CreateIndex
CREATE INDEX "UtilizationMetric_metricType_measuredAt_idx" ON "UtilizationMetric"("metricType", "measuredAt");

-- CreateIndex
CREATE INDEX "UtilizationMetric_scopeSegmentId_idx" ON "UtilizationMetric"("scopeSegmentId");

-- CreateIndex
CREATE INDEX "UtilizationMetric_scopeSiteId_idx" ON "UtilizationMetric"("scopeSiteId");

-- CreateIndex
CREATE INDEX "UtilizationMetric_scopeOdfId_idx" ON "UtilizationMetric"("scopeOdfId");

-- CreateIndex
CREATE INDEX "UtilizationMetric_scopeCableId_idx" ON "UtilizationMetric"("scopeCableId");

-- CreateIndex
CREATE INDEX "UtilizationMetric_sitePairKey_idx" ON "UtilizationMetric"("sitePairKey");

-- CreateIndex
CREATE UNIQUE INDEX "AlertPolicy_code_key" ON "AlertPolicy"("code");

-- CreateIndex
CREATE INDEX "AlertPolicy_alertType_enabled_idx" ON "AlertPolicy"("alertType", "enabled");

-- CreateIndex
CREATE INDEX "AlertSuppression_alertPolicyId_idx" ON "AlertSuppression"("alertPolicyId");

-- CreateIndex
CREATE INDEX "AlertSuppression_targetType_targetId_idx" ON "AlertSuppression"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AlertSuppression_sitePairKey_idx" ON "AlertSuppression"("sitePairKey");

-- CreateIndex
CREATE INDEX "AlertSuppression_startsAt_endsAt_idx" ON "AlertSuppression"("startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "AlertEvent_alertPolicyId_state_idx" ON "AlertEvent"("alertPolicyId", "state");

-- CreateIndex
CREATE INDEX "AlertEvent_linkSegmentId_idx" ON "AlertEvent"("linkSegmentId");

-- CreateIndex
CREATE INDEX "AlertEvent_siteId_idx" ON "AlertEvent"("siteId");

-- CreateIndex
CREATE INDEX "AlertEvent_sitePairKey_idx" ON "AlertEvent"("sitePairKey");

-- CreateIndex
CREATE INDEX "AlertEvent_severity_idx" ON "AlertEvent"("severity");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplate_code_key" ON "NotificationTemplate"("code");

-- CreateIndex
CREATE UNIQUE INDEX "RecipientGroup_code_key" ON "RecipientGroup"("code");

-- CreateIndex
CREATE INDEX "RecipientGroupMember_email_idx" ON "RecipientGroupMember"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RecipientGroupMember_recipientGroupId_email_key" ON "RecipientGroupMember"("recipientGroupId", "email");

-- CreateIndex
CREATE INDEX "NotificationLog_channel_status_idx" ON "NotificationLog"("channel", "status");

-- CreateIndex
CREATE INDEX "NotificationLog_recipient_idx" ON "NotificationLog"("recipient");

-- CreateIndex
CREATE INDEX "NotificationLog_userId_idx" ON "NotificationLog"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyReportSchedule_reportKey_key" ON "WeeklyReportSchedule"("reportKey");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_batchCode_key" ON "ImportBatch"("batchCode");

-- CreateIndex
CREATE INDEX "ImportBatch_status_idx" ON "ImportBatch"("status");

-- CreateIndex
CREATE INDEX "ImportBatch_uploadedById_idx" ON "ImportBatch"("uploadedById");

-- CreateIndex
CREATE INDEX "ImportStagingRow_status_idx" ON "ImportStagingRow"("status");

-- CreateIndex
CREATE INDEX "ImportStagingRow_mirrorKey_idx" ON "ImportStagingRow"("mirrorKey");

-- CreateIndex
CREATE INDEX "ImportStagingRow_rowHash_idx" ON "ImportStagingRow"("rowHash");

-- CreateIndex
CREATE UNIQUE INDEX "ImportStagingRow_importBatchId_rowNumber_key" ON "ImportStagingRow"("importBatchId", "rowNumber");

-- CreateIndex
CREATE INDEX "ImportIssue_importBatchId_severity_idx" ON "ImportIssue"("importBatchId", "severity");

-- CreateIndex
CREATE INDEX "ImportIssue_stagingRowId_idx" ON "ImportIssue"("stagingRowId");

-- CreateIndex
CREATE INDEX "ImportIssue_resolved_idx" ON "ImportIssue"("resolved");

-- CreateIndex
CREATE UNIQUE INDEX "Splitter_splitterCode_key" ON "Splitter"("splitterCode");

-- CreateIndex
CREATE INDEX "Splitter_scope_idx" ON "Splitter"("scope");

-- CreateIndex
CREATE INDEX "Splitter_status_idx" ON "Splitter"("status");

-- CreateIndex
CREATE INDEX "Splitter_importBatchId_idx" ON "Splitter"("importBatchId");

-- CreateIndex
CREATE INDEX "Splitter_primaryInputSiteCode_idx" ON "Splitter"("primaryInputSiteCode");

-- CreateIndex
CREATE INDEX "SplitterOutput_splitterId_idx" ON "SplitterOutput"("splitterId");

-- CreateIndex
CREATE INDEX "SplitterOutput_serviceCode_idx" ON "SplitterOutput"("serviceCode");

-- CreateIndex
CREATE INDEX "SplitterOutput_destinationSiteCode_idx" ON "SplitterOutput"("destinationSiteCode");

-- CreateIndex
CREATE INDEX "SplitterOutput_sharingCustomerServiceId_idx" ON "SplitterOutput"("sharingCustomerServiceId");

-- CreateIndex
CREATE INDEX "SplitterOutput_sharingCustomerServiceCode_idx" ON "SplitterOutput"("sharingCustomerServiceCode");

-- CreateIndex
CREATE INDEX "SplitterOutput_portGroupId_idx" ON "SplitterOutput"("portGroupId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_changedById_idx" ON "AuditLog"("changedById");

-- CreateIndex
CREATE INDEX "AuditLog_importBatchId_idx" ON "AuditLog"("importBatchId");

-- CreateIndex
CREATE INDEX "SystemChangeLog_timestamp_idx" ON "SystemChangeLog"("timestamp");

-- CreateIndex
CREATE INDEX "SystemChangeLog_batchId_idx" ON "SystemChangeLog"("batchId");

-- CreateIndex
CREATE INDEX "SystemChangeLog_targetTable_targetId_idx" ON "SystemChangeLog"("targetTable", "targetId");

-- CreateIndex
CREATE INDEX "SystemChangeLog_revertedAt_idx" ON "SystemChangeLog"("revertedAt");

-- CreateIndex
CREATE INDEX "UtilizationHistory_capturedAt_idx" ON "UtilizationHistory"("capturedAt");

-- CreateIndex
CREATE INDEX "UtilizationHistory_sourceTable_sourceId_idx" ON "UtilizationHistory"("sourceTable", "sourceId");

-- CreateIndex
CREATE INDEX "UtilizationHistory_siteId_idx" ON "UtilizationHistory"("siteId");

-- CreateIndex
CREATE INDEX "UtilizationHistory_odfId_idx" ON "UtilizationHistory"("odfId");

-- CreateIndex
CREATE INDEX "ImportMetadata_batchId_idx" ON "ImportMetadata"("batchId");

-- CreateIndex
CREATE INDEX "ImportMetadata_uploadedAt_idx" ON "ImportMetadata"("uploadedAt");

-- CreateIndex
CREATE INDEX "SegmentAttachment_segmentId_idx" ON "SegmentAttachment"("segmentId");

-- CreateIndex
CREATE INDEX "SegmentAttachment_siteId_idx" ON "SegmentAttachment"("siteId");

-- CreateIndex
CREATE INDEX "SegmentAttachment_documentType_idx" ON "SegmentAttachment"("documentType");

-- CreateIndex
CREATE INDEX "SegmentAttachment_uploadedAt_idx" ON "SegmentAttachment"("uploadedAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemporaryPassword" ADD CONSTRAINT "TemporaryPassword_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteAlias" ADD CONSTRAINT "SiteAlias_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteCriticalityAssignment" ADD CONSTRAINT "SiteCriticalityAssignment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteCriticalityAssignment" ADD CONSTRAINT "SiteCriticalityAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "SiteCriticalityTag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rack" ADD CONSTRAINT "Rack_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ODF" ADD CONSTRAINT "ODF_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ODF" ADD CONSTRAINT "ODF_rackId_fkey" FOREIGN KEY ("rackId") REFERENCES "Rack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ODFPort" ADD CONSTRAINT "ODFPort_odfId_fkey" FOREIGN KEY ("odfId") REFERENCES "ODF"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortGroup" ADD CONSTRAINT "PortGroup_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortGroup" ADD CONSTRAINT "PortGroup_rackId_fkey" FOREIGN KEY ("rackId") REFERENCES "Rack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortGroup" ADD CONSTRAINT "PortGroup_odfId_fkey" FOREIGN KEY ("odfId") REFERENCES "ODF"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortGroupMember" ADD CONSTRAINT "PortGroupMember_portGroupId_fkey" FOREIGN KEY ("portGroupId") REFERENCES "PortGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortGroupMember" ADD CONSTRAINT "PortGroupMember_odfPortId_fkey" FOREIGN KEY ("odfPortId") REFERENCES "ODFPort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cable" ADD CONSTRAINT "Cable_siteAId_fkey" FOREIGN KEY ("siteAId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cable" ADD CONSTRAINT "Cable_siteBId_fkey" FOREIGN KEY ("siteBId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentEndpoint" ADD CONSTRAINT "SegmentEndpoint_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentEndpoint" ADD CONSTRAINT "SegmentEndpoint_rackId_fkey" FOREIGN KEY ("rackId") REFERENCES "Rack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentEndpoint" ADD CONSTRAINT "SegmentEndpoint_odfId_fkey" FOREIGN KEY ("odfId") REFERENCES "ODF"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentEndpoint" ADD CONSTRAINT "SegmentEndpoint_portGroupId_fkey" FOREIGN KEY ("portGroupId") REFERENCES "PortGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkSegment" ADD CONSTRAINT "LinkSegment_endpointAId_fkey" FOREIGN KEY ("endpointAId") REFERENCES "SegmentEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkSegment" ADD CONSTRAINT "LinkSegment_endpointBId_fkey" FOREIGN KEY ("endpointBId") REFERENCES "SegmentEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkSegment" ADD CONSTRAINT "LinkSegment_cableId_fkey" FOREIGN KEY ("cableId") REFERENCES "Cable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkSegment" ADD CONSTRAINT "LinkSegment_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentFiber" ADD CONSTRAINT "SegmentFiber_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "LinkSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentFiber" ADD CONSTRAINT "SegmentFiber_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentFiber" ADD CONSTRAINT "SegmentFiber_serviceRouteId_fkey" FOREIGN KEY ("serviceRouteId") REFERENCES "ServiceRoute"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentFiber" ADD CONSTRAINT "SegmentFiber_serviceAllocationId_fkey" FOREIGN KEY ("serviceAllocationId") REFERENCES "ServiceAllocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentEndpointMapping" ADD CONSTRAINT "SegmentEndpointMapping_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "LinkSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentEndpointMapping" ADD CONSTRAINT "SegmentEndpointMapping_importStagingRowId_fkey" FOREIGN KEY ("importStagingRowId") REFERENCES "ImportStagingRow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentEndpointMapping" ADD CONSTRAINT "SegmentEndpointMapping_localPortGroupId_fkey" FOREIGN KEY ("localPortGroupId") REFERENCES "PortGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentEndpointMapping" ADD CONSTRAINT "SegmentEndpointMapping_farPortGroupId_fkey" FOREIGN KEY ("farPortGroupId") REFERENCES "PortGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRoute" ADD CONSTRAINT "ServiceRoute_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAllocation" ADD CONSTRAINT "ServiceAllocation_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAllocation" ADD CONSTRAINT "ServiceAllocation_serviceRouteId_fkey" FOREIGN KEY ("serviceRouteId") REFERENCES "ServiceRoute"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAllocation" ADD CONSTRAINT "ServiceAllocation_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "LinkSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAllocation" ADD CONSTRAINT "ServiceAllocation_fromSiteId_fkey" FOREIGN KEY ("fromSiteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAllocation" ADD CONSTRAINT "ServiceAllocation_toSiteId_fkey" FOREIGN KEY ("toSiteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAllocation" ADD CONSTRAINT "ServiceAllocation_endpointAId_fkey" FOREIGN KEY ("endpointAId") REFERENCES "SegmentEndpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAllocation" ADD CONSTRAINT "ServiceAllocation_endpointBId_fkey" FOREIGN KEY ("endpointBId") REFERENCES "SegmentEndpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAllocation" ADD CONSTRAINT "ServiceAllocation_endpointAPortGroupId_fkey" FOREIGN KEY ("endpointAPortGroupId") REFERENCES "PortGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAllocation" ADD CONSTRAINT "ServiceAllocation_endpointBPortGroupId_fkey" FOREIGN KEY ("endpointBPortGroupId") REFERENCES "PortGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRouteHop" ADD CONSTRAINT "ServiceRouteHop_serviceRouteId_fkey" FOREIGN KEY ("serviceRouteId") REFERENCES "ServiceRoute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRouteHop" ADD CONSTRAINT "ServiceRouteHop_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRouteHop" ADD CONSTRAINT "ServiceRouteHop_rackId_fkey" FOREIGN KEY ("rackId") REFERENCES "Rack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRouteHop" ADD CONSTRAINT "ServiceRouteHop_odfId_fkey" FOREIGN KEY ("odfId") REFERENCES "ODF"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRouteHop" ADD CONSTRAINT "ServiceRouteHop_portGroupId_fkey" FOREIGN KEY ("portGroupId") REFERENCES "PortGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRouteHop" ADD CONSTRAINT "ServiceRouteHop_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "LinkSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilizationMetric" ADD CONSTRAINT "UtilizationMetric_scopeSegmentId_fkey" FOREIGN KEY ("scopeSegmentId") REFERENCES "LinkSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilizationMetric" ADD CONSTRAINT "UtilizationMetric_scopeSiteId_fkey" FOREIGN KEY ("scopeSiteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilizationMetric" ADD CONSTRAINT "UtilizationMetric_scopeOdfId_fkey" FOREIGN KEY ("scopeOdfId") REFERENCES "ODF"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilizationMetric" ADD CONSTRAINT "UtilizationMetric_scopeCableId_fkey" FOREIGN KEY ("scopeCableId") REFERENCES "Cable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertSuppression" ADD CONSTRAINT "AlertSuppression_alertPolicyId_fkey" FOREIGN KEY ("alertPolicyId") REFERENCES "AlertPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertSuppression" ADD CONSTRAINT "AlertSuppression_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_alertPolicyId_fkey" FOREIGN KEY ("alertPolicyId") REFERENCES "AlertPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_linkSegmentId_fkey" FOREIGN KEY ("linkSegmentId") REFERENCES "LinkSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_odfId_fkey" FOREIGN KEY ("odfId") REFERENCES "ODF"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_metricId_fkey" FOREIGN KEY ("metricId") REFERENCES "UtilizationMetric"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_suppressionId_fkey" FOREIGN KEY ("suppressionId") REFERENCES "AlertSuppression"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipientGroupMember" ADD CONSTRAINT "RecipientGroupMember_recipientGroupId_fkey" FOREIGN KEY ("recipientGroupId") REFERENCES "RecipientGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_committedById_fkey" FOREIGN KEY ("committedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportStagingRow" ADD CONSTRAINT "ImportStagingRow_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportStagingRow" ADD CONSTRAINT "ImportStagingRow_normalizedSiteAId_fkey" FOREIGN KEY ("normalizedSiteAId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportStagingRow" ADD CONSTRAINT "ImportStagingRow_normalizedSiteBId_fkey" FOREIGN KEY ("normalizedSiteBId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportIssue" ADD CONSTRAINT "ImportIssue_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportIssue" ADD CONSTRAINT "ImportIssue_stagingRowId_fkey" FOREIGN KEY ("stagingRowId") REFERENCES "ImportStagingRow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportIssue" ADD CONSTRAINT "ImportIssue_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Splitter" ADD CONSTRAINT "Splitter_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitterOutput" ADD CONSTRAINT "SplitterOutput_splitterId_fkey" FOREIGN KEY ("splitterId") REFERENCES "Splitter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitterOutput" ADD CONSTRAINT "SplitterOutput_portGroupId_fkey" FOREIGN KEY ("portGroupId") REFERENCES "PortGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
