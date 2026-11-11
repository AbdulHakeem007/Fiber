
import {
  AlertSeverity,
  AlertState,
  AlertType,
  ChangeAction,
  EndpointSide,
  ImportBatchStatus,
  ImportRowStatus,
  IssueSeverity,
  MetricType,
  NotificationChannel,
  OdfStatus,
  PortGroupType,
  PrismaClient,
  RecordSource,
  ResourceStatus,
  RoleCode,
  RouteType,
  ServiceStatus,
  SiteStatus,
} from "@prisma/client";
import { randomBytes, scryptSync } from "crypto";

const prisma = new PrismaClient();

type SiteSeed = {
  code: string;
  name: string;
  region: string;
  city: string;
  siteType: string;
  isCoreSite?: boolean;
  coreSiteType?: string | null;
  status?: SiteStatus;
  aliases?: string[];
  remarks?: string;
};

type RackSeed = {
  siteCode: string;
  rackCode: string;
  name?: string;
  status?: OdfStatus;
};

type OdfSeed = {
  siteCode: string;
  rackCode: string;
  odfCode: string;
  maxPorts: number;
  status?: OdfStatus;
  remarks?: string;
};

type EndpointSeed = {
  siteCode: string;
  rackCode: string;
  odfCode: string;
  portLabel: string;
  rawSiteCode?: string;
  rawRackCode?: string;
  rawOdfCode?: string;
  remarks?: string;
  terminationStatus?: ResourceStatus;
};

type SegmentSeed = {
  segmentCode: string;
  cableCode?: string | null;
  routeLabel?: string | null;
  tubeNumber?: number | null;
  tubeColor?: string | null;
  tubeLabel?: string | null;
  fiberLabel?: string | null;
  fiberCount?: number | null;
  terminatedPairCount?: number | null;
  distanceKm?: number | null;
  status?: ResourceStatus;
  isPartialTermination?: boolean;
  manualOverride?: boolean;
  overrideReason?: string | null;
  comments?: string | null;
  installedAt?: Date | null;
  decommissionedAt?: Date | null;
  source?: RecordSource;
  importBatchCode?: string | null;
  endpointA: EndpointSeed;
  endpointB: EndpointSeed;
};

const now = new Date("2026-05-08T20:00:00.000Z");

function hashSeedPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${key}`;
}

function normalizeAlias(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function pairKey(a: string, b: string) {
  return [a, b].sort().join("::");
}

function parsePortLabel(label: string): { ports: number[]; groupType: PortGroupType; startPortNumber: number | null; endPortNumber: number | null } {
  const clean = label.trim();

  if (clean.includes(",")) {
    const ports = clean
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isFinite(x));

    return {
      ports,
      groupType: ports.length === 1 ? PortGroupType.SINGLE : PortGroupType.CUSTOM,
      startPortNumber: ports.length ? Math.min(...ports) : null,
      endPortNumber: ports.length ? Math.max(...ports) : null,
    };
  }

  if (clean.includes("-")) {
    const [a, b] = clean.split("-").map((x) => Number(x.trim()));
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const ports = a <= b ? [a, b] : [b, a];
      return {
        ports,
        groupType: ports.length === 2 ? PortGroupType.PAIR : PortGroupType.CUSTOM,
        startPortNumber: Math.min(...ports),
        endPortNumber: Math.max(...ports),
      };
    }
  }

  const single = Number(clean);
  if (Number.isFinite(single)) {
    return {
      ports: [single],
      groupType: PortGroupType.SINGLE,
      startPortNumber: single,
      endPortNumber: single,
    };
  }

  return {
    ports: [],
    groupType: PortGroupType.CUSTOM,
    startPortNumber: null,
    endPortNumber: null,
  };
}

async function clearDatabase() {
  await prisma.auditLog.deleteMany();
  await prisma.notificationLog.deleteMany();
  await prisma.recipientGroupMember.deleteMany();
  await prisma.recipientGroup.deleteMany();
  await prisma.notificationTemplate.deleteMany();
  await prisma.smtpConfiguration.deleteMany();
  await prisma.importIssue.deleteMany();
  await prisma.importStagingRow.deleteMany();
  await prisma.alertEvent.deleteMany();
  await prisma.alertSuppression.deleteMany();
  await prisma.alertPolicy.deleteMany();
  await prisma.utilizationMetric.deleteMany();
  await prisma.serviceRouteHop.deleteMany();
  await prisma.segmentFiber.deleteMany();
  await prisma.serviceAllocation.deleteMany();
  await prisma.serviceRoute.deleteMany();
  await prisma.service.deleteMany();
  await prisma.linkSegment.deleteMany();
  await prisma.importBatch.deleteMany();
  await prisma.segmentEndpoint.deleteMany();
  await prisma.cable.deleteMany();
  await prisma.portGroupMember.deleteMany();
  await prisma.portGroup.deleteMany();
  await prisma.oDFPort.deleteMany();
  await prisma.oDF.deleteMany();
  await prisma.rack.deleteMany();
  await prisma.siteAlias.deleteMany();
  await prisma.siteCriticalityAssignment.deleteMany();
  await prisma.siteCriticalityTag.deleteMany();
  await prisma.temporaryPassword.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.user.deleteMany();
  await prisma.role.deleteMany();
  await prisma.site.deleteMany();
}

async function seedRolesAndUsers() {
  const adminRole = await prisma.role.create({
    data: {
      code: RoleCode.ADMIN,
      name: "Admin",
      description: "Full access including users, alert policies, imports, and audit history.",
      permissionsJson: JSON.stringify({
        dashboard: "rw",
        inventory: "rw",
        importCenter: "rw",
        alerts: "rw",
        reports: "rw",
        admin: "rw",
        audit: "rw",
      }),
    },
  });

  const rwRole = await prisma.role.create({
    data: {
      code: RoleCode.READ_WRITE,
      name: "Read / Write",
      description: "Operational editor for mappings, reservations, releases, and remarks.",
      permissionsJson: JSON.stringify({
        dashboard: "r",
        inventory: "rw",
        importCenter: "rw",
        alerts: "ack",
        reports: "r",
        admin: "none",
        audit: "r",
      }),
    },
  });

  const roRole = await prisma.role.create({
    data: {
      code: RoleCode.READ_ONLY,
      name: "Read Only",
      description: "View/search/export only.",
      permissionsJson: JSON.stringify({
        dashboard: "r",
        inventory: "r",
        importCenter: "r",
        alerts: "r",
        reports: "r",
        admin: "none",
        audit: "none",
      }),
    },
  });

  const admin = await prisma.user.create({
    data: {
      email: "admin@fiber-portal.local",
      name: "Arjun N.",
      passwordHash: hashSeedPassword("admin123"),
      passwordChangedAt: now,
      roleId: adminRole.id,
      isActive: true,
      lastLoginAt: new Date("2026-05-08T18:15:00.000Z"),
    },
  });

  const planner = await prisma.user.create({
    data: {
      email: "planner@fiber-portal.local",
      name: "Priya S.",
      passwordHash: hashSeedPassword("planner123"),
      passwordChangedAt: now,
      roleId: rwRole.id,
      isActive: true,
      lastLoginAt: new Date("2026-05-08T17:42:00.000Z"),
    },
  });

  const viewer = await prisma.user.create({
    data: {
      email: "viewer@fiber-portal.local",
      name: "Rahul T.",
      passwordHash: hashSeedPassword("viewer123"),
      passwordChangedAt: now,
      roleId: roRole.id,
      isActive: true,
      lastLoginAt: new Date("2026-05-08T16:10:00.000Z"),
    },
  });

  const permissions = [
    ["inventoryRead", "Inventory Read", "inventory"],
    ["inventoryWrite", "Inventory Write", "inventory"],
    ["importManage", "Import / Export Manage", "import"],
    ["alertAcknowledge", "Alert Acknowledge", "alerts"],
    ["adminManage", "Admin Manage", "admin"],
  ] as const;

  const permissionRecords = new Map<string, { id: string }>();
  for (const [code, name, module] of permissions) {
    const permission = await prisma.permission.create({
      data: { code, name, module },
      select: { id: true },
    });
    permissionRecords.set(code, permission);
  }

  const rolePermissions: Record<RoleCode, string[]> = {
    ADMIN: permissions.map(([code]) => code),
    READ_WRITE: ["inventoryRead", "inventoryWrite", "importManage", "alertAcknowledge"],
    READ_ONLY: ["inventoryRead"],
  };

  for (const [roleCode, permissionCodes] of Object.entries(rolePermissions) as Array<[RoleCode, string[]]>) {
    const role = roleCode === RoleCode.ADMIN ? adminRole : roleCode === RoleCode.READ_WRITE ? rwRole : roRole;
    for (const permissionCode of permissionCodes) {
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permissionRecords.get(permissionCode)!.id },
      });
    }
  }

  await prisma.userRole.createMany({
    data: [
      { userId: admin.id, roleId: adminRole.id, isPrimary: true },
      { userId: planner.id, roleId: rwRole.id, isPrimary: true },
      { userId: viewer.id, roleId: roRole.id, isPrimary: true },
    ],
  });

  await prisma.notificationTemplate.create({
    data: {
      code: "DEFAULT_ALERT_EMAIL",
      name: "Default alert email",
      channel: NotificationChannel.EMAIL,
      subject: "[{{severity}}] {{alert_name}} - {{site_pair}}",
      body: "Alert {{alert_code}} at {{timestamp}}\nSeverity: {{severity}}\nSite pair: {{site_pair}}\nUtilization: {{utilization}}\nRack/ODF: {{rack_odf}}\nService: {{service_id}}\nPortal: {{portal_link}}",
      placeholdersJson: JSON.stringify(["alert_name", "alert_code", "severity", "site_pair", "utilization", "rack_odf", "service_id", "timestamp", "portal_link"]),
      isActive: true,
    },
  });

  const group = await prisma.recipientGroup.create({
    data: {
      code: "NOC",
      name: "Network Operations",
      description: "Default NOC alias for utilization and import warnings.",
    },
  });
  await prisma.recipientGroupMember.createMany({
    data: [
      { recipientGroupId: group.id, email: "transport-ops@example.com", displayName: "Transport Ops" },
      { recipientGroupId: group.id, email: "fiber-planning@example.com", displayName: "Fiber Planning" },
    ],
  });

  return { admin, planner, viewer };
}

async function seedSites() {
  const sites: SiteSeed[] = [
    {
      code: "MU0282",
      name: "Mumbai Aggregation Hub",
      region: "West",
      city: "Mumbai",
      siteType: "Hub",
      isCoreSite: true,
      coreSiteType: "PE",
      aliases: ["Site-A", "MU282", "Mumbai Hub"],
      remarks: "High-connectivity hub used for dashboard spotlight and service trace demos.",
    },
    {
      code: "BA1041",
      name: "Bandra Access Node",
      region: "West",
      city: "Mumbai",
      siteType: "Access",
      aliases: ["Site-B", "Bandra Node"],
    },
    {
      code: "SH2231",
      name: "Andheri Aggregation Node",
      region: "West",
      city: "Mumbai",
      siteType: "Aggregation",
      aliases: ["Site-C", "Andheri Hub"],
    },
    {
      code: "DA1180",
      name: "Powai Distribution Node",
      region: "West",
      city: "Mumbai",
      siteType: "Distribution",
      aliases: ["Site-D", "Powai Node"],
    },
    {
      code: "PNQ2211",
      name: "Pune Edge POP",
      region: "West",
      city: "Pune",
      siteType: "POP",
      aliases: ["Site-E", "Pune Edge"],
    },
    {
      code: "KLY1220",
      name: "Kalyan Metro POP",
      region: "West",
      city: "Kalyan",
      siteType: "POP",
      aliases: ["Site-F", "Kalyan POP"],
    },
    {
      code: "NYC3310",
      name: "New Yard Core Node",
      region: "West",
      city: "Navi Mumbai",
      siteType: "Core Edge",
      aliases: ["Site-G", "Navi Core"],
    },
    {
      code: "PBL5500",
      name: "Panvel Bypass Loop",
      region: "West",
      city: "Panvel",
      siteType: "Metro Ring",
      aliases: ["Site-H", "Panvel Loop"],
    },
    {
      code: "NGP4450",
      name: "Nagpur Transit POP",
      region: "Central",
      city: "Nagpur",
      siteType: "Transit",
      aliases: ["Site-I", "Nagpur Transit"],
    },
    {
      code: "MSC9901",
      name: "MSC / BSC Central",
      region: "West",
      city: "Mumbai",
      siteType: "Core",
      isCoreSite: true,
      coreSiteType: "DWDM",
      aliases: ["MSC&BSC", "Site-J", "Core-MSC-BSC"],
      remarks: "Legacy core location with OTN and MPLS adjacency plus imported alias history.",
    },
  ];

  const siteMap = new Map<string, { id: string; code: string }>();

  for (const site of sites) {
    const created = await prisma.site.create({
      data: {
        code: site.code,
        name: site.name,
        region: site.region,
        city: site.city,
        siteType: site.siteType,
        isCoreSite: site.isCoreSite ?? false,
        coreSiteType: site.coreSiteType,
        status: site.status ?? SiteStatus.ACTIVE,
        remarks: site.remarks,
      },
    });

    siteMap.set(site.code, { id: created.id, code: created.code });

    const aliases = [site.code, ...(site.aliases ?? [])];
    for (let i = 0; i < aliases.length; i += 1) {
      await prisma.siteAlias.create({
        data: {
          siteId: created.id,
          alias: aliases[i],
          aliasNormalized: normalizeAlias(aliases[i]),
          isPrimary: i === 0,
          source: i === 0 ? RecordSource.SYSTEM : RecordSource.IMPORT,
        },
      });
    }

    const criticalities = new Set<string>();
    if (site.coreSiteType?.includes("DWDM") && site.coreSiteType?.includes("PE")) criticalities.add("PE/DWDM");
    else if (site.coreSiteType) criticalities.add(site.coreSiteType);
    if (/access/i.test(site.siteType)) criticalities.add("Access");
    for (const label of criticalities) {
      const tag = await prisma.siteCriticalityTag.upsert({
        where: { code: label.toUpperCase().replace(/[^A-Z0-9]+/g, "_") },
        update: { label },
        create: { code: label.toUpperCase().replace(/[^A-Z0-9]+/g, "_"), label },
      });
      await prisma.siteCriticalityAssignment.create({ data: { siteId: created.id, tagId: tag.id } });
    }
  }

  return siteMap;
}

async function seedRacksAndOdfs(siteMap: Map<string, { id: string; code: string }>) {
  const racks: RackSeed[] = [
    { siteCode: "MU0282", rackCode: "R01", name: "Aggregation Rack 01" },
    { siteCode: "MU0282", rackCode: "R02", name: "Aggregation Rack 02" },
    { siteCode: "MU0282", rackCode: "R03", name: "Expansion Rack 03" },

    { siteCode: "BA1041", rackCode: "R03", name: "Outdoor Cabinet / A" },
    { siteCode: "SH2231", rackCode: "R02", name: "Outdoor Cabinet / A" },
    { siteCode: "DA1180", rackCode: "R01", name: "Unit A Rack 01" },
    { siteCode: "DA1180", rackCode: "R02", name: "Unit A Rack 02" },

    { siteCode: "PNQ2211", rackCode: "R02", name: "Unit A Rack 02" },
    { siteCode: "PNQ2211", rackCode: "R03", name: "Unit A Rack 03" },

    { siteCode: "KLY1220", rackCode: "R01", name: "AJ26 Main Rack" },
    { siteCode: "NYC3310", rackCode: "R01", name: "AJ26 Main Rack" },
    { siteCode: "PBL5500", rackCode: "R01", name: "AJ24 Main Rack" },

    { siteCode: "NGP4450", rackCode: "R01", name: "AJ26 Main Rack" },
    { siteCode: "NGP4450", rackCode: "R02", name: "AJ24 Legacy Rack" },

    { siteCode: "MSC9901", rackCode: "CORE-01", name: "03B02 Core Rack" },
    { siteCode: "MSC9901", rackCode: "CORE-02", name: "01C03 Core Rack" },
  ];

  const odfs: OdfSeed[] = [
    { siteCode: "MU0282", rackCode: "R01", odfCode: "ODF-A1", maxPorts: 96 },
    { siteCode: "MU0282", rackCode: "R02", odfCode: "ODF-A3", maxPorts: 96 },
    { siteCode: "MU0282", rackCode: "R03", odfCode: "ODF-A5", maxPorts: 144 },

    { siteCode: "BA1041", rackCode: "R03", odfCode: "ODF-B2", maxPorts: 96 },
    { siteCode: "SH2231", rackCode: "R02", odfCode: "ODF-C1", maxPorts: 96 },

    { siteCode: "DA1180", rackCode: "R01", odfCode: "ODF-D1", maxPorts: 96 },
    { siteCode: "DA1180", rackCode: "R02", odfCode: "ODF-D3", maxPorts: 96 },

    { siteCode: "PNQ2211", rackCode: "R02", odfCode: "ODF-E1", maxPorts: 144 },
    { siteCode: "PNQ2211", rackCode: "R03", odfCode: "ODF-E3", maxPorts: 144 },

    { siteCode: "KLY1220", rackCode: "R01", odfCode: "ODF-F2", maxPorts: 96 },
    { siteCode: "NYC3310", rackCode: "R01", odfCode: "ODF-G1", maxPorts: 96 },
    { siteCode: "PBL5500", rackCode: "R01", odfCode: "ODF-H1", maxPorts: 96 },

    { siteCode: "NGP4450", rackCode: "R01", odfCode: "ODF-I1", maxPorts: 144 },
    { siteCode: "NGP4450", rackCode: "R02", odfCode: "ODF-I2", maxPorts: 96 },

    { siteCode: "MSC9901", rackCode: "CORE-01", odfCode: "ODF-M1", maxPorts: 144 },
    { siteCode: "MSC9901", rackCode: "CORE-02", odfCode: "ODF-M2", maxPorts: 144 },
  ];

  for (const rack of racks) {
    const site = siteMap.get(rack.siteCode)!;
    await prisma.rack.create({
      data: {
        siteId: site.id,
        rackCode: rack.rackCode,
        name: rack.name,
        status: rack.status ?? OdfStatus.ACTIVE,
      },
    });
  }

  for (const odf of odfs) {
    const site = siteMap.get(odf.siteCode)!;
    const rack = await prisma.rack.findFirstOrThrow({
      where: {
        siteId: site.id,
        rackCode: odf.rackCode,
      },
    });

    const createdOdf = await prisma.oDF.create({
      data: {
        siteId: site.id,
        rackId: rack.id,
        odfCode: odf.odfCode,
        maxPorts: odf.maxPorts,
        status: odf.status ?? OdfStatus.ACTIVE,
        remarks: odf.remarks,
      },
    });

    await prisma.oDFPort.createMany({
      data: Array.from({ length: odf.maxPorts }, (_, index) => ({
        odfId: createdOdf.id,
        portNumber: index + 1,
        label: `${index + 1}`,
        status: ResourceStatus.AVAILABLE,
      })),
    });
  }
}

async function findSite(siteCode: string) {
  return prisma.site.findUniqueOrThrow({ where: { code: siteCode } });
}

async function findRack(siteCode: string, rackCode: string) {
  const site = await findSite(siteCode);
  return prisma.rack.findFirstOrThrow({ where: { siteId: site.id, rackCode } });
}

async function findOdf(siteCode: string, rackCode: string, odfCode: string) {
  const site = await findSite(siteCode);
  const rack = await findRack(siteCode, rackCode);
  return prisma.oDF.findFirstOrThrow({
    where: {
      siteId: site.id,
      rackId: rack.id,
      odfCode,
    },
  });
}

async function ensurePortGroup(
  siteCode: string,
  rackCode: string,
  odfCode: string,
  portLabel: string,
  status: ResourceStatus,
  source: RecordSource,
  reservationNote?: string,
) {
  const odf = await findOdf(siteCode, rackCode, odfCode);
  const existing = await prisma.portGroup.findFirst({
    where: {
      odfId: odf.id,
      displayLabel: portLabel.trim(),
    },
  });

  if (existing) {
    return existing;
  }

  const parsed = parsePortLabel(portLabel);
  const created = await prisma.portGroup.create({
    data: {
      siteId: odf.siteId,
      rackId: odf.rackId,
      odfId: odf.id,
      groupType: parsed.groupType,
      displayLabel: portLabel.trim(),
      startPortNumber: parsed.startPortNumber,
      endPortNumber: parsed.endPortNumber,
      status,
      reservationNote,
      source,
    },
  });

  for (let i = 0; i < parsed.ports.length; i += 1) {
    const odfPort = await prisma.oDFPort.findFirstOrThrow({
      where: {
        odfId: odf.id,
        portNumber: parsed.ports[i],
      },
    });

    await prisma.portGroupMember.create({
      data: {
        portGroupId: created.id,
        odfPortId: odfPort.id,
        sequence: i + 1,
      },
    });

    await prisma.oDFPort.update({
      where: { id: odfPort.id },
      data: { status },
    });
  }

  return created;
}

async function ensureCable(
  cableCode: string,
  siteACode: string,
  siteBCode: string,
  totalFibers: number | null,
  distanceKm: number | null,
  routeLabel: string | null,
  status: ResourceStatus = ResourceStatus.ACTIVE,
) {
  const existing = await prisma.cable.findFirst({ where: { cableCode } });
  if (existing) return existing;

  const siteA = await findSite(siteACode);
  const siteB = await findSite(siteBCode);

  return prisma.cable.create({
    data: {
      cableCode,
      cableName: cableCode,
      cableType: "SMF",
      totalFibers: totalFibers ?? undefined,
      routeLabel: routeLabel ?? undefined,
      distanceKm: distanceKm ?? undefined,
      siteAId: siteA.id,
      siteBId: siteB.id,
      status,
    },
  });
}

async function createSegment(seed: SegmentSeed) {
  const aSite = await findSite(seed.endpointA.siteCode);
  const bSite = await findSite(seed.endpointB.siteCode);

  const aRack = await findRack(seed.endpointA.siteCode, seed.endpointA.rackCode);
  const bRack = await findRack(seed.endpointB.siteCode, seed.endpointB.rackCode);

  const aOdf = await findOdf(seed.endpointA.siteCode, seed.endpointA.rackCode, seed.endpointA.odfCode);
  const bOdf = await findOdf(seed.endpointB.siteCode, seed.endpointB.rackCode, seed.endpointB.odfCode);

  const aGroup = await ensurePortGroup(
    seed.endpointA.siteCode,
    seed.endpointA.rackCode,
    seed.endpointA.odfCode,
    seed.endpointA.portLabel,
    seed.endpointA.terminationStatus ?? (seed.status ?? ResourceStatus.ACTIVE),
    seed.source ?? RecordSource.IMPORT,
  );

  const bGroup = await ensurePortGroup(
    seed.endpointB.siteCode,
    seed.endpointB.rackCode,
    seed.endpointB.odfCode,
    seed.endpointB.portLabel,
    seed.endpointB.terminationStatus ?? (seed.status ?? ResourceStatus.ACTIVE),
    seed.source ?? RecordSource.IMPORT,
  );

  const endpointA = await prisma.segmentEndpoint.create({
    data: {
      endpointSide: EndpointSide.A,
      siteId: aSite.id,
      rackId: aRack.id,
      odfId: aOdf.id,
      portGroupId: aGroup.id,
      rawSiteCode: seed.endpointA.rawSiteCode ?? seed.endpointA.siteCode,
      rawRackCode: seed.endpointA.rawRackCode ?? seed.endpointA.rackCode,
      rawOdfCode: seed.endpointA.rawOdfCode ?? seed.endpointA.odfCode,
      rawPortText: seed.endpointA.portLabel,
      displayPortText: seed.endpointA.portLabel,
      terminationStatus: seed.endpointA.terminationStatus ?? (seed.status ?? ResourceStatus.ACTIVE),
      remarks: seed.endpointA.remarks,
    },
  });

  const endpointB = await prisma.segmentEndpoint.create({
    data: {
      endpointSide: EndpointSide.B,
      siteId: bSite.id,
      rackId: bRack.id,
      odfId: bOdf.id,
      portGroupId: bGroup.id,
      rawSiteCode: seed.endpointB.rawSiteCode ?? seed.endpointB.siteCode,
      rawRackCode: seed.endpointB.rawRackCode ?? seed.endpointB.rackCode,
      rawOdfCode: seed.endpointB.rawOdfCode ?? seed.endpointB.odfCode,
      rawPortText: seed.endpointB.portLabel,
      displayPortText: seed.endpointB.portLabel,
      terminationStatus: seed.endpointB.terminationStatus ?? (seed.status ?? ResourceStatus.ACTIVE),
      remarks: seed.endpointB.remarks,
    },
  });

  const cable =
    seed.cableCode && seed.endpointA.siteCode !== seed.endpointB.siteCode
      ? await ensureCable(
          seed.cableCode,
          seed.endpointA.siteCode,
          seed.endpointB.siteCode,
          seed.fiberCount ?? null,
          seed.distanceKm ?? null,
          seed.routeLabel ?? null,
          seed.status ?? ResourceStatus.ACTIVE,
        )
      : null;

  const importBatch =
    seed.importBatchCode
      ? await prisma.importBatch.findFirst({ where: { batchCode: seed.importBatchCode } })
      : null;

  return prisma.linkSegment.create({
    data: {
      segmentCode: seed.segmentCode,
      sitePairKey: pairKey(seed.endpointA.siteCode, seed.endpointB.siteCode),
      endpointAId: endpointA.id,
      endpointBId: endpointB.id,
      cableId: cable?.id,
      routeLabel: seed.routeLabel ?? undefined,
      tubeNumber: seed.tubeNumber ?? undefined,
      tubeColor: seed.tubeColor ?? undefined,
      tubeLabel: seed.tubeLabel ?? undefined,
      fiberLabel: seed.fiberLabel ?? undefined,
      fiberCount: seed.fiberCount ?? undefined,
      terminatedPairCount: seed.terminatedPairCount ?? undefined,
      distanceKm: seed.distanceKm ?? undefined,
      status: seed.status ?? ResourceStatus.ACTIVE,
      isPartialTermination: seed.isPartialTermination ?? false,
      manualOverride: seed.manualOverride ?? false,
      overrideReason: seed.overrideReason ?? undefined,
      comments: seed.comments ?? undefined,
      installedAt: seed.installedAt ?? undefined,
      decommissionedAt: seed.decommissionedAt ?? undefined,
      source: seed.source ?? RecordSource.IMPORT,
      importBatchId: importBatch?.id,
    },
  });
}

async function seedImportBatch(users: Awaited<ReturnType<typeof seedRolesAndUsers>>) {
  return prisma.importBatch.create({
    data: {
      batchCode: "IMP-2026-05-08-001",
      fileName: "Current ODF Template.xlsx",
      fileChecksum: "seed-simulated-sha256-current-template",
      sourceSystem: "DEMO_SEED",
      templateVersion: "current-template-v1",
      status: ImportBatchStatus.COMMITTED,
      uploadedById: users.planner.id,
      reviewedById: users.admin.id,
      committedById: users.admin.id,
      uploadedAt: new Date("2026-05-08T14:12:00.000Z"),
      reviewedAt: new Date("2026-05-08T14:32:00.000Z"),
      committedAt: new Date("2026-05-08T15:05:00.000Z"),
      totalRows: 18,
      validRows: 14,
      warningRows: 3,
      errorRows: 1,
      committedRows: 14,
      summaryText:
        "Demo seed data isolated from live workflows unless demo mode is explicitly enabled.",
      comments:
        "Rows using Site-A / Site-B style aliases were normalized to MU0282 / BA1041 / SH2231. One mirror candidate and one missing far-end ODF kept in staging for review history.",
    },
  });
}

async function seedSegments(importBatchCode: string) {
  const segments: SegmentSeed[] = [
    {
      segmentCode: "SEG-MU0282-BA1041-01",
      cableCode: "CBL-78451",
      routeLabel: "MU0282 -> BA1041",
      tubeLabel: "T12",
      fiberLabel: "13-14",
      fiberCount: 48,
      terminatedPairCount: 24,
      distanceKm: 8.7,
      status: ResourceStatus.ACTIVE,
      installedAt: new Date("2025-01-12T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "MU0282", rackCode: "R01", odfCode: "ODF-A1", portLabel: "13-14", rawSiteCode: "Site-A", rawRackCode: "AJ26" },
      endpointB: { siteCode: "BA1041", rackCode: "R03", odfCode: "ODF-B2", portLabel: "1-2", rawSiteCode: "Site-B", rawRackCode: "OUT DOOR CABINET /A" },
    },
    {
      segmentCode: "SEG-MU0282-BA1041-02",
      cableCode: "CBL-78451",
      routeLabel: "MU0282 -> BA1041 Protection",
      tubeLabel: "T12",
      fiberLabel: "15-16",
      fiberCount: 48,
      terminatedPairCount: 24,
      distanceKm: 8.7,
      status: ResourceStatus.RESERVED,
      manualOverride: true,
      overrideReason: "Protection pair reserved by transport planning for Enterprise VPN failover.",
      installedAt: new Date("2025-02-05T00:00:00.000Z"),
      source: RecordSource.MANUAL,
      endpointA: { siteCode: "MU0282", rackCode: "R01", odfCode: "ODF-A1", portLabel: "15-16", rawSiteCode: "Site-A" },
      endpointB: { siteCode: "BA1041", rackCode: "R03", odfCode: "ODF-B2", portLabel: "13-14", rawSiteCode: "Site-B" },
    },
    {
      segmentCode: "SEG-MU0282-SH2231-01",
      cableCode: "CBL-78452",
      routeLabel: "MU0282 -> SH2231",
      tubeLabel: "T08",
      fiberLabel: "21-22",
      fiberCount: 48,
      terminatedPairCount: 24,
      distanceKm: 11.2,
      status: ResourceStatus.ACTIVE,
      installedAt: new Date("2025-03-20T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "MU0282", rackCode: "R02", odfCode: "ODF-A3", portLabel: "21-22", rawSiteCode: "Site-A" },
      endpointB: { siteCode: "SH2231", rackCode: "R02", odfCode: "ODF-C1", portLabel: "5-6", rawSiteCode: "Site-C" },
    },
    {
      segmentCode: "SEG-MU0282-DA1180-01",
      cableCode: "CBL-78453",
      routeLabel: "MU0282 -> DA1180",
      tubeLabel: "T04",
      fiberLabel: "23-24",
      fiberCount: 48,
      terminatedPairCount: 24,
      distanceKm: 15.4,
      status: ResourceStatus.ACTIVE,
      installedAt: new Date("2025-03-28T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "MU0282", rackCode: "R02", odfCode: "ODF-A3", portLabel: "23-24", rawSiteCode: "Site-A" },
      endpointB: { siteCode: "DA1180", rackCode: "R01", odfCode: "ODF-D1", portLabel: "7-8", rawSiteCode: "Site-D" },
    },
    {
      segmentCode: "SEG-MU0282-PNQ2211-01",
      cableCode: "CBL-78454",
      routeLabel: "MU0282 -> PNQ2211",
      tubeLabel: "T06",
      fiberLabel: "25-26",
      fiberCount: 72,
      terminatedPairCount: 18,
      distanceKm: 18.6,
      status: ResourceStatus.ACTIVE,
      installedAt: new Date("2025-04-01T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "MU0282", rackCode: "R03", odfCode: "ODF-A5", portLabel: "25-26", rawSiteCode: "Site-A" },
      endpointB: { siteCode: "PNQ2211", rackCode: "R02", odfCode: "ODF-E1", portLabel: "1-2", rawSiteCode: "Site-E" },
    },
    {
      segmentCode: "SEG-MU0282-KLY1220-01",
      cableCode: "CBL-78455",
      routeLabel: "MU0282 -> KLY1220",
      tubeLabel: "T09",
      fiberLabel: "31-32",
      fiberCount: 48,
      terminatedPairCount: 24,
      distanceKm: 22.3,
      status: ResourceStatus.RESERVED,
      manualOverride: true,
      overrideReason: "Held for upcoming DWDM grooming window.",
      installedAt: new Date("2025-04-09T00:00:00.000Z"),
      source: RecordSource.MANUAL,
      endpointA: { siteCode: "MU0282", rackCode: "R03", odfCode: "ODF-A5", portLabel: "31-32", rawSiteCode: "Site-A" },
      endpointB: { siteCode: "KLY1220", rackCode: "R01", odfCode: "ODF-F2", portLabel: "3-4", rawSiteCode: "Site-F" },
    },
    {
      segmentCode: "SEG-MU0282-PBL5500-01",
      cableCode: "CBL-78456",
      routeLabel: "MU0282 -> PBL5500",
      tubeLabel: "T10",
      fiberLabel: "33-34",
      fiberCount: 48,
      terminatedPairCount: 24,
      distanceKm: 19.9,
      status: ResourceStatus.ACTIVE,
      installedAt: new Date("2025-04-15T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "MU0282", rackCode: "R03", odfCode: "ODF-A5", portLabel: "33-34", rawSiteCode: "Site-A" },
      endpointB: { siteCode: "PBL5500", rackCode: "R01", odfCode: "ODF-H1", portLabel: "9-10", rawSiteCode: "Site-H" },
    },
    {
      segmentCode: "SEG-MU0282-NGP4450-01",
      cableCode: "CBL-78457",
      routeLabel: "MU0282 -> NGP4450",
      tubeLabel: "T15",
      fiberLabel: "35-36",
      fiberCount: 48,
      terminatedPairCount: 24,
      distanceKm: 27.8,
      status: ResourceStatus.ACTIVE,
      installedAt: new Date("2025-04-22T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "MU0282", rackCode: "R03", odfCode: "ODF-A5", portLabel: "35-36", rawSiteCode: "Site-A" },
      endpointB: { siteCode: "NGP4450", rackCode: "R01", odfCode: "ODF-I1", portLabel: "13-14", rawSiteCode: "Site-I" },
    },
    {
      segmentCode: "SEG-MU0282-NYC3310-01",
      cableCode: "CBL-78458",
      routeLabel: "MU0282 -> NYC3310",
      tubeLabel: "T11",
      fiberLabel: "37-38",
      fiberCount: 48,
      terminatedPairCount: 24,
      distanceKm: 24.1,
      status: ResourceStatus.ACTIVE,
      installedAt: new Date("2025-05-03T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "MU0282", rackCode: "R03", odfCode: "ODF-A5", portLabel: "37-38", rawSiteCode: "Site-A" },
      endpointB: { siteCode: "NYC3310", rackCode: "R01", odfCode: "ODF-G1", portLabel: "1-2", rawSiteCode: "Site-G" },
    },
    {
      segmentCode: "SEG-BA1041-SH2231-01",
      cableCode: null,
      routeLabel: "Bandra L2 Spur",
      tubeLabel: null,
      fiberLabel: null,
      fiberCount: null,
      terminatedPairCount: 12,
      distanceKm: 9.2,
      status: ResourceStatus.ACTIVE,
      comments: "Legacy Excel import had usable ODF mapping but missing cable metadata. Good seed row for data-gap handling.",
      installedAt: new Date("2025-04-12T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "BA1041", rackCode: "R03", odfCode: "ODF-B2", portLabel: "21-22", rawSiteCode: "Site-B" },
      endpointB: { siteCode: "SH2231", rackCode: "R02", odfCode: "ODF-C1", portLabel: "13-14", rawSiteCode: "Site-C" },
    },
    {
      segmentCode: "SEG-SH2231-DA1180-01",
      cableCode: "CBL-79012",
      routeLabel: "SH2231 -> DA1180",
      tubeLabel: "T03",
      fiberLabel: "25-26",
      fiberCount: 60,
      terminatedPairCount: 20,
      distanceKm: 10.7,
      status: ResourceStatus.ACTIVE,
      installedAt: new Date("2025-04-14T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "SH2231", rackCode: "R02", odfCode: "ODF-C1", portLabel: "25-26", rawSiteCode: "Site-C" },
      endpointB: { siteCode: "DA1180", rackCode: "R01", odfCode: "ODF-D1", portLabel: "1-2", rawSiteCode: "Site-D" },
    },
    {
      segmentCode: "SEG-DA1180-PNQ2211-01",
      cableCode: "CBL-79013",
      routeLabel: "DA1180 -> PNQ2211",
      tubeLabel: "T07",
      fiberLabel: "29-30",
      fiberCount: 60,
      terminatedPairCount: 20,
      distanceKm: 12.4,
      status: ResourceStatus.ACTIVE,
      installedAt: new Date("2025-04-18T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "DA1180", rackCode: "R02", odfCode: "ODF-D3", portLabel: "29-30", rawSiteCode: "Site-D" },
      endpointB: { siteCode: "PNQ2211", rackCode: "R02", odfCode: "ODF-E1", portLabel: "13-14", rawSiteCode: "Site-E" },
    },
    {
      segmentCode: "SEG-PNQ2211-KLY1220-01",
      cableCode: "CBL-79014",
      routeLabel: "PNQ2211 -> KLY1220",
      tubeLabel: "T04",
      fiberLabel: "37-38",
      fiberCount: 72,
      terminatedPairCount: 24,
      distanceKm: 9.6,
      status: ResourceStatus.ACTIVE,
      isPartialTermination: true,
      comments: "Cable is 72F but only first 48 ports currently terminated. Remaining fibers are spare/not yet landed.",
      installedAt: new Date("2025-04-25T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "PNQ2211", rackCode: "R03", odfCode: "ODF-E3", portLabel: "37-38", rawSiteCode: "Site-E" },
      endpointB: { siteCode: "KLY1220", rackCode: "R01", odfCode: "ODF-F2", portLabel: "13-14", rawSiteCode: "Site-F" },
    },
    {
      segmentCode: "SEG-KLY1220-NYC3310-01",
      cableCode: "CBL-79015",
      routeLabel: "KLY1220 -> NYC3310",
      tubeLabel: "T05",
      fiberLabel: "15-16",
      fiberCount: 48,
      terminatedPairCount: 24,
      distanceKm: 13.8,
      status: ResourceStatus.ACTIVE,
      installedAt: new Date("2025-04-29T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "KLY1220", rackCode: "R01", odfCode: "ODF-F2", portLabel: "15-16", rawSiteCode: "Site-F" },
      endpointB: { siteCode: "NYC3310", rackCode: "R01", odfCode: "ODF-G1", portLabel: "9-10", rawSiteCode: "Site-G" },
    },
    {
      segmentCode: "SEG-NYC3310-BA1041-01",
      cableCode: "CBL-79016",
      routeLabel: "NYC3310 -> BA1041",
      tubeLabel: "T01",
      fiberLabel: "11-12",
      fiberCount: 48,
      terminatedPairCount: 24,
      distanceKm: 15.1,
      status: ResourceStatus.ACTIVE,
      installedAt: new Date("2025-05-02T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "NYC3310", rackCode: "R01", odfCode: "ODF-G1", portLabel: "11-12", rawSiteCode: "Site-G" },
      endpointB: { siteCode: "BA1041", rackCode: "R03", odfCode: "ODF-B2", portLabel: "9-10", rawSiteCode: "Site-B" },
    },
    {
      segmentCode: "SEG-PBL5500-NGP4450-01",
      cableCode: "CBL-79017",
      routeLabel: "PBL5500 -> NGP4450",
      tubeLabel: "T18",
      fiberLabel: "21-22",
      fiberCount: 72,
      terminatedPairCount: 24,
      distanceKm: 17.5,
      status: ResourceStatus.ACTIVE,
      installedAt: new Date("2025-05-04T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "PBL5500", rackCode: "R01", odfCode: "ODF-H1", portLabel: "21-22", rawSiteCode: "Site-H" },
      endpointB: { siteCode: "NGP4450", rackCode: "R02", odfCode: "ODF-I2", portLabel: "5-6", rawSiteCode: "Site-I" },
    },
    {
      segmentCode: "SEG-NGP4450-MSC9901-01",
      cableCode: "CBL-79018",
      routeLabel: "NGP4450 -> MSC9901",
      tubeLabel: "T22",
      fiberLabel: "61-62",
      fiberCount: 96,
      terminatedPairCount: 36,
      distanceKm: 39.0,
      status: ResourceStatus.ACTIVE,
      installedAt: new Date("2025-05-08T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "NGP4450", rackCode: "R01", odfCode: "ODF-I1", portLabel: "61-62", rawSiteCode: "Site-I" },
      endpointB: { siteCode: "MSC9901", rackCode: "CORE-02", odfCode: "ODF-M2", portLabel: "25-26", rawSiteCode: "MSC&BSC" },
    },
    {
      segmentCode: "SEG-PBL5500-MSC9901-01",
      cableCode: "CBL-79019",
      routeLabel: "PBL5500 -> MSC9901 Protection",
      tubeLabel: "T24",
      fiberLabel: "63-64",
      fiberCount: 96,
      terminatedPairCount: 36,
      distanceKm: 34.5,
      status: ResourceStatus.RESERVED,
      manualOverride: true,
      overrideReason: "Reserved for core reroute during MSC modernization.",
      installedAt: new Date("2025-05-10T00:00:00.000Z"),
      source: RecordSource.MANUAL,
      endpointA: { siteCode: "PBL5500", rackCode: "R01", odfCode: "ODF-H1", portLabel: "23-24", rawSiteCode: "Site-H" },
      endpointB: { siteCode: "MSC9901", rackCode: "CORE-01", odfCode: "ODF-M1", portLabel: "63-64", rawSiteCode: "MSC&BSC" },
    },
    {
      segmentCode: "SEG-DA1180-MSC9901-LEGACY",
      cableCode: null,
      routeLabel: "Legacy direct tie",
      tubeLabel: null,
      fiberLabel: null,
      fiberCount: null,
      terminatedPairCount: 8,
      distanceKm: null,
      status: ResourceStatus.FAULTY,
      comments: "Historically relevant tie cable retained for audit/history. Current distance unknown; cable sheet never captured.",
      installedAt: new Date("2023-11-18T00:00:00.000Z"),
      decommissionedAt: new Date("2025-02-14T00:00:00.000Z"),
      source: RecordSource.IMPORT,
      importBatchCode,
      endpointA: { siteCode: "DA1180", rackCode: "R02", odfCode: "ODF-D3", portLabel: "41-42", rawSiteCode: "Site-D" },
      endpointB: { siteCode: "MSC9901", rackCode: "CORE-01", odfCode: "ODF-M1", portLabel: "73-74", rawSiteCode: "MSC&BSC" },
    },
  ];

  const created = [];
  for (const segment of segments) {
    created.push(await createSegment(segment));
  }

  // Extra standalone groups for dashboard variety
  await ensurePortGroup("MU0282", "R03", "ODF-A5", "39-40", ResourceStatus.SPARE, RecordSource.MANUAL);
  await ensurePortGroup("MU0282", "R03", "ODF-A5", "41-42", ResourceStatus.FAULTY, RecordSource.MANUAL);
  await ensurePortGroup("DA1180", "R02", "ODF-D3", "21-22", ResourceStatus.SPARE, RecordSource.MANUAL);
  await ensurePortGroup("PNQ2211", "R03", "ODF-E3", "49-50", ResourceStatus.DUMMY, RecordSource.MANUAL);
  await ensurePortGroup("MSC9901", "CORE-01", "ODF-M1", "75-76", ResourceStatus.PLANNED, RecordSource.MANUAL);

  return created;
}

async function seedServices() {
  const segments = await prisma.linkSegment.findMany({
    include: {
      endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
      endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
    },
  });

  const byCode = new Map(segments.map((s) => [s.segmentCode, s]));

  const vpn = await prisma.service.create({
    data: {
      serviceCode: "SV-2048",
      serviceName: "Enterprise VPN 2048",
      serviceType: "EVPN",
      customerName: "Global Enterprises Ltd.",
      status: ServiceStatus.ACTIVE,
      remarks: "Demo service matching the UI trace panel.",
    },
  });

  const vpnWorking = await prisma.serviceRoute.create({
    data: {
      serviceId: vpn.id,
      routeName: "SV-2048 Working",
      routeType: RouteType.WORKING,
      priority: 1,
      isActive: true,
      slaClass: "Gold (99.9%)",
      protectionMode: "None",
    },
  });

  const vpnProtection = await prisma.serviceRoute.create({
    data: {
      serviceId: vpn.id,
      routeName: "SV-2048 Protection",
      routeType: RouteType.PROTECTION,
      priority: 2,
      isActive: false,
      slaClass: "Gold (99.9%)",
      protectionMode: "Manual reserve",
    },
  });

  const vpnWorkingSegments = [
    byCode.get("SEG-MU0282-BA1041-01")!,
    byCode.get("SEG-BA1041-SH2231-01")!,
    byCode.get("SEG-SH2231-DA1180-01")!,
  ];

  for (let i = 0; i < vpnWorkingSegments.length; i += 1) {
    const seg = vpnWorkingSegments[i];
    await prisma.serviceRouteHop.create({
      data: {
        serviceRouteId: vpnWorking.id,
        hopOrder: i + 1,
        siteId: seg.endpointA.siteId ?? undefined,
        rackId: seg.endpointA.rackId ?? undefined,
        odfId: seg.endpointA.odfId ?? undefined,
        portGroupId: seg.endpointA.portGroupId ?? undefined,
        segmentId: seg.id,
        pathLabel: `${seg.endpointA.site?.code} -> ${seg.endpointB.site?.code}`,
        distanceKm: seg.distanceKm ?? undefined,
      },
    });
  }

  const vpnProtectionSegments = [
    byCode.get("SEG-MU0282-NYC3310-01")!,
    byCode.get("SEG-NYC3310-BA1041-01")!,
    byCode.get("SEG-BA1041-SH2231-01")!,
    byCode.get("SEG-SH2231-DA1180-01")!,
  ];

  for (let i = 0; i < vpnProtectionSegments.length; i += 1) {
    const seg = vpnProtectionSegments[i];
    await prisma.serviceRouteHop.create({
      data: {
        serviceRouteId: vpnProtection.id,
        hopOrder: i + 1,
        siteId: seg.endpointA.siteId ?? undefined,
        rackId: seg.endpointA.rackId ?? undefined,
        odfId: seg.endpointA.odfId ?? undefined,
        portGroupId: seg.endpointA.portGroupId ?? undefined,
        segmentId: seg.id,
        pathLabel: `${seg.endpointA.site?.code} -> ${seg.endpointB.site?.code}`,
        distanceKm: seg.distanceKm ?? undefined,
        isProtectionHop: true,
      },
    });
  }

  const bh = await prisma.service.create({
    data: {
      serviceCode: "BH-MU-NGP-001",
      serviceName: "4G/5G Backhaul MU-NGP-MSC",
      serviceType: "Backhaul",
      customerName: "Mobile Core",
      status: ServiceStatus.ACTIVE,
      remarks: "Backhaul service with direct MU -> NGP and onward to MSC core.",
    },
  });

  const bhRoute = await prisma.serviceRoute.create({
    data: {
      serviceId: bh.id,
      routeName: "Backhaul Working",
      routeType: RouteType.WORKING,
      priority: 1,
      isActive: true,
      slaClass: "Platinum",
      protectionMode: "1+1 at packet layer",
    },
  });

  for (const [index, segCode] of ["SEG-MU0282-NGP4450-01", "SEG-NGP4450-MSC9901-01"].entries()) {
    const seg = byCode.get(segCode)!;
    await prisma.serviceRouteHop.create({
      data: {
        serviceRouteId: bhRoute.id,
        hopOrder: index + 1,
        siteId: seg.endpointA.siteId ?? undefined,
        rackId: seg.endpointA.rackId ?? undefined,
        odfId: seg.endpointA.odfId ?? undefined,
        portGroupId: seg.endpointA.portGroupId ?? undefined,
        segmentId: seg.id,
        pathLabel: `${seg.endpointA.site?.code} -> ${seg.endpointB.site?.code}`,
        distanceKm: seg.distanceKm ?? undefined,
      },
    });
  }

  const iplc = await prisma.service.create({
    data: {
      serviceCode: "IPLC-9001",
      serviceName: "Corporate IPLC 9001",
      serviceType: "IPLC",
      customerName: "FinCore Holdings",
      status: ServiceStatus.ACTIVE,
      remarks: "Demonstrates longer trace with multiple metro and core handoffs.",
    },
  });

  const iplcWorking = await prisma.serviceRoute.create({
    data: {
      serviceId: iplc.id,
      routeName: "IPLC Working",
      routeType: RouteType.WORKING,
      priority: 1,
      isActive: true,
      slaClass: "Enterprise Premium",
      protectionMode: "Protected via reserved core leg",
    },
  });

  for (const [index, segCode] of [
    "SEG-MU0282-PBL5500-01",
    "SEG-PBL5500-NGP4450-01",
    "SEG-NGP4450-MSC9901-01",
  ].entries()) {
    const seg = byCode.get(segCode)!;
    await prisma.serviceRouteHop.create({
      data: {
        serviceRouteId: iplcWorking.id,
        hopOrder: index + 1,
        siteId: seg.endpointA.siteId ?? undefined,
        rackId: seg.endpointA.rackId ?? undefined,
        odfId: seg.endpointA.odfId ?? undefined,
        portGroupId: seg.endpointA.portGroupId ?? undefined,
        segmentId: seg.id,
        pathLabel: `${seg.endpointA.site?.code} -> ${seg.endpointB.site?.code}`,
        distanceKm: seg.distanceKm ?? undefined,
      },
    });
  }
}

async function seedUtilizationAndAlerts(users: Awaited<ReturnType<typeof seedRolesAndUsers>>) {
  const segments = await prisma.linkSegment.findMany();
  const sitePairs = [
    { key: "MU0282::BA1041", used: 48, total: 50, pct: 96 },
    { key: "SH2231::DA1180", used: 56, total: 60, pct: 93 },
    { key: "BA1041::SH2231", used: 40, total: 45, pct: 89 },
    { key: "MU0282::DA1180", used: 39, total: 50, pct: 78 },
    { key: "DA1180::PNQ2211", used: 27, total: 38, pct: 71 },
    { key: "MU0282::NYC3310", used: 18, total: 32, pct: 56 },
  ];

  for (const pair of sitePairs) {
    await prisma.utilizationMetric.create({
      data: {
        metricType: MetricType.SITE_PAIR_UTILIZATION,
        sitePairKey: pair.key,
        totalGroups: pair.total,
        usedGroups: pair.used,
        spareGroups: Math.max(pair.total - pair.used - 1, 0),
        reservedGroups: 1,
        faultyGroups: 0,
        utilizationPct: pair.pct,
        denominatorNote: "Total terminated port groups visible to operations",
        calculationNote: "Aggregated by normalized site pair key; duplicate mirrors suppressed.",
        measuredAt: now,
        source: RecordSource.SYSTEM,
      },
    });
  }

  for (const segment of segments) {
    const metricPctBySegment: Record<string, number> = {
      "SEG-MU0282-BA1041-01": 96,
      "SEG-MU0282-BA1041-02": 12,
      "SEG-MU0282-SH2231-01": 89,
      "SEG-MU0282-DA1180-01": 78,
      "SEG-MU0282-PNQ2211-01": 74,
      "SEG-MU0282-KLY1220-01": 22,
      "SEG-MU0282-PBL5500-01": 63,
      "SEG-MU0282-NGP4450-01": 58,
      "SEG-MU0282-NYC3310-01": 56,
      "SEG-BA1041-SH2231-01": 89,
      "SEG-SH2231-DA1180-01": 93,
      "SEG-DA1180-PNQ2211-01": 71,
      "SEG-PNQ2211-KLY1220-01": 81,
      "SEG-KLY1220-NYC3310-01": 68,
      "SEG-NYC3310-BA1041-01": 75,
      "SEG-PBL5500-NGP4450-01": 66,
      "SEG-NGP4450-MSC9901-01": 61,
      "SEG-PBL5500-MSC9901-01": 14,
      "SEG-DA1180-MSC9901-LEGACY": 0,
    };

    const pct = metricPctBySegment[segment.segmentCode] ?? 0;
    await prisma.utilizationMetric.create({
      data: {
        metricType: MetricType.SEGMENT_UTILIZATION,
        scopeSegmentId: segment.id,
        sitePairKey: segment.sitePairKey,
        totalGroups: 24,
        usedGroups: Math.round((pct / 100) * 24),
        spareGroups: Math.max(24 - Math.round((pct / 100) * 24) - (segment.status === ResourceStatus.RESERVED ? 2 : 0), 0),
        reservedGroups: segment.status === ResourceStatus.RESERVED ? 2 : 0,
        faultyGroups: segment.status === ResourceStatus.FAULTY ? 4 : 0,
        utilizationPct: pct,
        denominatorNote: "Terminated pair count for the specific segment",
        calculationNote: segment.isPartialTermination
          ? "Partial termination logic applied; denominator uses terminated pairs, not cable fiber count."
          : "Standard segment denominator on terminated pairs.",
        measuredAt: now,
        source: RecordSource.SYSTEM,
      },
    });
  }

  const highUtilPolicy = await prisma.alertPolicy.create({
    data: {
      code: "UTIL-HIGH",
      name: "High Utilization",
      alertType: AlertType.HIGH_UTILIZATION,
      metricType: MetricType.SEGMENT_UTILIZATION,
      enabled: true,
      warningThresholdPct: 80,
      criticalThresholdPct: 90,
      consecutiveHits: 2,
      cooldownMinutes: 120,
      hysteresisPct: 5,
      notificationChannel: NotificationChannel.EMAIL,
      notifyEmails: "transport-ops@example.com,fiber-planning@example.com",
      allowManualSuppress: true,
      notes: "Avoid alert noise for short-lived grooming spikes.",
    },
  });

  const dataGapPolicy = await prisma.alertPolicy.create({
    data: {
      code: "DATA-GAP-CABLE",
      name: "Missing Cable Information",
      alertType: AlertType.MISSING_CABLE_INFORMATION,
      metricType: MetricType.SEGMENT_UTILIZATION,
      enabled: true,
      warningThresholdPct: null,
      criticalThresholdPct: null,
      consecutiveHits: 1,
      cooldownMinutes: 1440,
      hysteresisPct: 0,
      notificationChannel: NotificationChannel.IN_APP,
      notifyEmails: null,
      allowManualSuppress: true,
      notes: "Used where segment is operational but cable metadata remains absent.",
    },
  });

  const partialTermPolicy = await prisma.alertPolicy.create({
    data: {
      code: "PARTIAL-TERM",
      name: "Partial Termination",
      alertType: AlertType.PARTIAL_TERMINATION,
      metricType: MetricType.SEGMENT_UTILIZATION,
      enabled: true,
      warningThresholdPct: null,
      criticalThresholdPct: null,
      consecutiveHits: 1,
      cooldownMinutes: 720,
      hysteresisPct: 0,
      notificationChannel: NotificationChannel.IN_APP,
      notifyEmails: null,
      allowManualSuppress: true,
      notes: "Informational/operational alert for mismatch between cable size and landed terminations.",
    },
  });

  const suppression = await prisma.alertSuppression.create({
    data: {
      alertPolicyId: highUtilPolicy.id,
      targetType: "SITE_PAIR",
      sitePairKey: "MU0282::NYC3310",
      reason: "Known grooming window this week; suppress warning churn until maintenance closes.",
      startsAt: new Date("2026-05-07T00:00:00.000Z"),
      endsAt: new Date("2026-05-10T23:59:59.000Z"),
      createdById: users.admin.id,
    },
  });

  const segmentMU_BA = await prisma.linkSegment.findFirstOrThrow({ where: { segmentCode: "SEG-MU0282-BA1041-01" } });
  const segmentBA_SH = await prisma.linkSegment.findFirstOrThrow({ where: { segmentCode: "SEG-BA1041-SH2231-01" } });
  const segmentPN_KL = await prisma.linkSegment.findFirstOrThrow({ where: { segmentCode: "SEG-PNQ2211-KLY1220-01" } });

  const metricMU_BA = await prisma.utilizationMetric.findFirstOrThrow({
    where: { scopeSegmentId: segmentMU_BA.id, metricType: MetricType.SEGMENT_UTILIZATION },
  });
  const metricSH_DA = await prisma.utilizationMetric.findFirstOrThrow({
    where: { sitePairKey: "SH2231::DA1180", metricType: MetricType.SITE_PAIR_UTILIZATION },
  });
  const metricBA_SH = await prisma.utilizationMetric.findFirstOrThrow({
    where: { scopeSegmentId: segmentBA_SH.id, metricType: MetricType.SEGMENT_UTILIZATION },
  });

  await prisma.alertEvent.create({
    data: {
      alertPolicyId: highUtilPolicy.id,
      alertType: AlertType.HIGH_UTILIZATION,
      severity: AlertSeverity.CRITICAL,
      state: AlertState.OPEN,
      linkSegmentId: segmentMU_BA.id,
      metricId: metricMU_BA.id,
      sitePairKey: "MU0282::BA1041",
      title: "High utilization > 90%",
      message: "MU0282 ↔ BA1041 is running at 96% of terminated pair capacity.",
      hitCount: 3,
      firstSeenAt: new Date("2026-05-08T05:00:00.000Z"),
      lastSeenAt: new Date("2026-05-08T09:05:00.000Z"),
    },
  });

  await prisma.alertEvent.create({
    data: {
      alertPolicyId: highUtilPolicy.id,
      alertType: AlertType.HIGH_UTILIZATION,
      severity: AlertSeverity.WARNING,
      state: AlertState.ACKNOWLEDGED,
      sitePairKey: "SH2231::DA1180",
      metricId: metricSH_DA.id,
      title: "Elevated utilization",
      message: "SH2231 ↔ DA1180 crossed the warning threshold and was acknowledged by operations.",
      hitCount: 2,
      firstSeenAt: new Date("2026-05-08T04:40:00.000Z"),
      lastSeenAt: new Date("2026-05-08T08:40:00.000Z"),
      acknowledgedById: users.planner.id,
      acknowledgedAt: new Date("2026-05-08T08:45:00.000Z"),
    },
  });

  await prisma.alertEvent.create({
    data: {
      alertPolicyId: dataGapPolicy.id,
      alertType: AlertType.MISSING_CABLE_INFORMATION,
      severity: AlertSeverity.WARNING,
      state: AlertState.OPEN,
      linkSegmentId: segmentBA_SH.id,
      metricId: metricBA_SH.id,
      sitePairKey: "BA1041::SH2231",
      title: "Missing cable information",
      message: "Operational ODF mapping exists but cable code / route record is still missing.",
      hitCount: 1,
      firstSeenAt: new Date("2026-05-08T06:15:00.000Z"),
      lastSeenAt: new Date("2026-05-08T06:15:00.000Z"),
    },
  });

  await prisma.alertEvent.create({
    data: {
      alertPolicyId: partialTermPolicy.id,
      alertType: AlertType.PARTIAL_TERMINATION,
      severity: AlertSeverity.WARNING,
      state: AlertState.OPEN,
      linkSegmentId: segmentPN_KL.id,
      sitePairKey: "KLY1220::PNQ2211",
      title: "Partial termination",
      message: "72F cable present, but only a subset of port groups is terminated and operational.",
      hitCount: 1,
      firstSeenAt: new Date("2026-05-08T07:10:00.000Z"),
      lastSeenAt: new Date("2026-05-08T07:10:00.000Z"),
      suppressionId: suppression.id,
    },
  });
}

async function seedImportStaging(importBatchId: string, users: Awaited<ReturnType<typeof seedRolesAndUsers>>) {
  const mu = await prisma.site.findUniqueOrThrow({ where: { code: "MU0282" } });
  const ba = await prisma.site.findUniqueOrThrow({ where: { code: "BA1041" } });
  const sh = await prisma.site.findUniqueOrThrow({ where: { code: "SH2231" } });
  const da = await prisma.site.findUniqueOrThrow({ where: { code: "DA1180" } });
  const importedMirror = await prisma.linkSegment.findFirstOrThrow({ where: { segmentCode: "SEG-MU0282-BA1041-01" } });

  const row1 = await prisma.importStagingRow.create({
    data: {
      importBatchId,
      rowNumber: 2,
      status: ImportRowStatus.COMMITTED,
      rawJson: JSON.stringify({
        sheet: "Site-A",
        rack: "AJ26",
        odf: "ODF A",
        portPair: "13-14",
        direction: "To Site-B",
        definition: "ATN Ring1",
      }),
      normalizedJson: JSON.stringify({
        siteA: "MU0282",
        rackA: "R01",
        odfA: "ODF-A1",
        portA: "13-14",
        siteB: "BA1041",
        rackB: "R03",
        odfB: "ODF-B2",
        portB: "1-2",
      }),
      normalizedSiteAId: mu.id,
      normalizedSiteBId: ba.id,
      proposedSegmentCode: "SEG-MU0282-BA1041-01",
      mirrorKey: "MU0282|BA1041|13-14|1-2",
      rowHash: "seed-row-hash-0001",
      reviewerComment: "Accepted after alias normalization from Site-A / Site-B.",
    },
  });

  const row2 = await prisma.importStagingRow.create({
    data: {
      importBatchId,
      rowNumber: 3,
      status: ImportRowStatus.WARNING,
      rawJson: JSON.stringify({
        sheet: "Site-B",
        rack: "OUT DOOR CABINET /A",
        odf: "ODF B",
        portPair: "1-2",
        direction: "To Site-A",
        definition: "ATN Ring1",
      }),
      normalizedJson: JSON.stringify({
        siteA: "BA1041",
        rackA: "R03",
        odfA: "ODF-B2",
        portA: "1-2",
        siteB: "MU0282",
        rackB: "R01",
        odfB: "ODF-A1",
        portB: "13-14",
      }),
      normalizedSiteAId: ba.id,
      normalizedSiteBId: mu.id,
      proposedSegmentCode: "SEG-MU0282-BA1041-01",
      mirrorKey: "MU0282|BA1041|13-14|1-2",
      rowHash: "seed-row-hash-0002",
      duplicateOfSegmentId: importedMirror.id,
      reviewerComment: "Retained for traceability; marked as mirror candidate of existing physical segment.",
    },
  });

  const row3 = await prisma.importStagingRow.create({
    data: {
      importBatchId,
      rowNumber: 9,
      status: ImportRowStatus.WARNING,
      rawJson: JSON.stringify({
        sheet: "Site-C",
        rack: "OUT DOOR CABINET /A",
        odf: "ODF A",
        portPair: "25-26",
        direction: "To Site-D",
        definition: "ATN Ring1",
      }),
      normalizedJson: JSON.stringify({
        siteA: "SH2231",
        rackA: "R02",
        odfA: "ODF-C1",
        portA: "25-26",
        siteB: "DA1180",
        rackB: "R01",
        odfB: "ODF-D1",
        portB: "1-2",
      }),
      normalizedSiteAId: sh.id,
      normalizedSiteBId: da.id,
      proposedSegmentCode: "SEG-SH2231-DA1180-01",
      mirrorKey: "SH2231|DA1180|25-26|1-2",
      rowHash: "seed-row-hash-0003",
      reviewerComment: "Committed with warning because far-end route metadata was absent in Excel source.",
    },
  });

  const row4 = await prisma.importStagingRow.create({
    data: {
      importBatchId,
      rowNumber: 11,
      status: ImportRowStatus.ERROR,
      rawJson: JSON.stringify({
        sheet: "MSC&BSC",
        rack: "03B02",
        odf: "ODF D",
        portPair: "83-84",
        direction: "To Site-E",
        definition: "ATN Ring 2",
      }),
      normalizedJson: JSON.stringify({
        siteA: "MSC9901",
        rackA: "CORE-01",
        odfA: "ODF-M1",
        portA: "83-84",
        siteB: "PNQ2211",
        rackB: null,
        odfB: null,
        portB: null,
      }),
      normalizedSiteAId: (await prisma.site.findUniqueOrThrow({ where: { code: "MSC9901" } })).id,
      normalizedSiteBId: (await prisma.site.findUniqueOrThrow({ where: { code: "PNQ2211" } })).id,
      proposedSegmentCode: "SEG-MSC9901-PNQ2211-TBD",
      mirrorKey: "MSC9901|PNQ2211|83-84|UNKNOWN",
      rowHash: "seed-row-hash-0004",
      reviewerComment: "Held in staging because far-end ODF detail is missing and could not be safely auto-mapped.",
    },
  });

  await prisma.importIssue.createMany({
    data: [
      {
        importBatchId,
        stagingRowId: row2.id,
        severity: IssueSeverity.WARNING,
        issueCode: "MIRROR_DUPLICATE",
        fieldName: "direction",
        message: "Same physical link imported from opposite site sheet.",
        suggestedFix: "Commit only one canonical LinkSegment and keep the reverse row for audit traceability.",
        blocking: false,
        resolved: true,
        resolvedById: users.admin.id,
        resolvedAt: new Date("2026-05-08T14:48:00.000Z"),
      },
      {
        importBatchId,
        stagingRowId: row3.id,
        severity: IssueSeverity.WARNING,
        issueCode: "MISSING_ROUTE_META",
        fieldName: "definition",
        message: "Route/tube/cable information absent in Excel row, but endpoint mapping was still usable.",
        suggestedFix: "Commit the mapping and enrich cable metadata later.",
        blocking: false,
        resolved: true,
        resolvedById: users.admin.id,
        resolvedAt: new Date("2026-05-08T14:52:00.000Z"),
      },
      {
        importBatchId,
        stagingRowId: row4.id,
        severity: IssueSeverity.ERROR,
        issueCode: "MISSING_FAR_END_MAPPING",
        fieldName: "farEndOdfId",
        message: "Far-end site was inferable but far-end rack/ODF/port details were missing.",
        suggestedFix: "Keep row in staging until field verification is completed.",
        blocking: true,
        resolved: false,
      },
      {
        importBatchId,
        stagingRowId: row1.id,
        severity: IssueSeverity.INFO,
        issueCode: "ALIAS_NORMALIZED",
        fieldName: "siteCode",
        message: "Site-A normalized to MU0282 and Site-B normalized to BA1041.",
        suggestedFix: "No action required.",
        blocking: false,
        resolved: true,
        resolvedById: users.admin.id,
        resolvedAt: new Date("2026-05-08T14:35:00.000Z"),
      },
    ],
  });
}

async function seedAuditLogs(users: Awaited<ReturnType<typeof seedRolesAndUsers>>, importBatchId: string) {
  const segmentReserved = await prisma.linkSegment.findFirstOrThrow({ where: { segmentCode: "SEG-MU0282-BA1041-02" } });
  const legacy = await prisma.linkSegment.findFirstOrThrow({ where: { segmentCode: "SEG-DA1180-MSC9901-LEGACY" } });
  const siteMU = await prisma.site.findUniqueOrThrow({ where: { code: "MU0282" } });

  await prisma.auditLog.createMany({
    data: [
      {
        entityType: "ImportBatch",
        entityId: importBatchId,
        action: ChangeAction.IMPORT,
        newValue: "COMMITTED",
        reason: "Seed import of legacy workbook",
        comment: "Bulk committed validated rows from Current ODF Template.xlsx",
        changedById: users.admin.id,
        importBatchId,
        ipAddress: "10.25.7.18",
        userAgent: "seed-script/1.0",
        createdAt: new Date("2026-05-08T15:05:00.000Z"),
      },
      {
        entityType: "LinkSegment",
        entityId: segmentReserved.id,
        action: ChangeAction.RESERVE,
        fieldName: "status",
        oldValue: ResourceStatus.AVAILABLE,
        newValue: ResourceStatus.RESERVED,
        reason: "Protection pair reservation",
        comment: "Reserved by planning for Enterprise VPN failover cutover window.",
        changedById: users.planner.id,
        ipAddress: "10.25.7.21",
        userAgent: "chrome",
        createdAt: new Date("2026-05-08T15:40:00.000Z"),
      },
      {
        entityType: "LinkSegment",
        entityId: legacy.id,
        action: ChangeAction.UPDATE,
        fieldName: "status",
        oldValue: ResourceStatus.ACTIVE,
        newValue: ResourceStatus.FAULTY,
        reason: "Historical tie retained after decommission",
        comment: "Legacy tie left in inventory for audit reference only.",
        changedById: users.admin.id,
        ipAddress: "10.25.7.18",
        userAgent: "chrome",
        createdAt: new Date("2026-05-08T16:05:00.000Z"),
      },
      {
        entityType: "Site",
        entityId: siteMU.id,
        action: ChangeAction.UPDATE,
        fieldName: "remarks",
        oldValue: null,
        newValue: "Hub capacity reviewed and spare pairs retained in ODF-A5.",
        reason: "Operational annotation",
        comment: "Added by planner after utilization review.",
        changedById: users.planner.id,
        ipAddress: "10.25.7.21",
        userAgent: "chrome",
        createdAt: new Date("2026-05-08T16:22:00.000Z"),
      },
      {
        entityType: "AlertEvent",
        entityId: "seed-login-placeholder",
        action: ChangeAction.LOGIN,
        reason: "User session established",
        comment: "Viewer logged in and opened service trace dashboard.",
        changedById: users.viewer.id,
        ipAddress: "10.25.7.31",
        userAgent: "chrome",
        createdAt: new Date("2026-05-08T16:30:00.000Z"),
      },
    ],
  });
}

async function main() {
  await clearDatabase();

  const users = await seedRolesAndUsers();
  if (process.env.FEATURE_DEMO_DATA !== "true") {
    const summary = {
      roles: await prisma.role.count(),
      users: await prisma.user.count(),
      sites: await prisma.site.count(),
      racks: await prisma.rack.count(),
      odfs: await prisma.oDF.count(),
      linkSegments: await prisma.linkSegment.count(),
      services: await prisma.service.count(),
    };

    console.log("Production seed completed. Demo inventory is disabled unless FEATURE_DEMO_DATA=true.");
    console.table(summary);
    return;
  }

  const siteMap = await seedSites();
  await seedRacksAndOdfs(siteMap);

  const importBatch = await seedImportBatch(users);
  await seedSegments(importBatch.batchCode);
  await seedServices();
  await seedUtilizationAndAlerts(users);
  await seedImportStaging(importBatch.id, users);
  await seedAuditLogs(users, importBatch.id);

  const summary = {
    roles: await prisma.role.count(),
    users: await prisma.user.count(),
    sites: await prisma.site.count(),
    racks: await prisma.rack.count(),
    odfs: await prisma.oDF.count(),
    odfPorts: await prisma.oDFPort.count(),
    portGroups: await prisma.portGroup.count(),
    linkSegments: await prisma.linkSegment.count(),
    cables: await prisma.cable.count(),
    services: await prisma.service.count(),
    routes: await prisma.serviceRoute.count(),
    routeHops: await prisma.serviceRouteHop.count(),
    utilizationMetrics: await prisma.utilizationMetric.count(),
    alertPolicies: await prisma.alertPolicy.count(),
    alertEvents: await prisma.alertEvent.count(),
    importBatches: await prisma.importBatch.count(),
    stagingRows: await prisma.importStagingRow.count(),
    importIssues: await prisma.importIssue.count(),
    auditLogs: await prisma.auditLog.count(),
  };

  console.log("Fiber portal seed completed.");
  console.table(summary);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
