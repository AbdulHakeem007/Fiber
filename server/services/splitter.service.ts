import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";
import type { SplitterInventoryRow, SplitterOutputRow, SplitterListFilters, SplitterListPage, SplitterSummary } from "@/types/splitters";

type SplitterRecord = Prisma.SplitterGetPayload<{ include: { _count: { select: { outputs: true } } } }>;
type SplitterOutputRecord = Prisma.SplitterOutputGetPayload<object>;

function contains(value?: string | null): Prisma.StringFilter | undefined {
  const text = value?.trim();
  return text ? { contains: text } : undefined;
}

function splitterWhere(filters: SplitterListFilters = {}): Prisma.SplitterWhereInput {
  const and: Prisma.SplitterWhereInput[] = [];
  const search = filters.search?.trim();
  if (search) {
    and.push({
      OR: [
        { splitterCode: contains(search) },
        { splitterName: contains(search) },
        { location: contains(search) },
        { locationContext: contains(search) },
        { primaryInputSiteCode: contains(search) },
        { primaryInputRackCode: contains(search) },
        { primaryInputOdfCode: contains(search) },
        { primaryInputPortLabel: contains(search) },
        { secondaryInputSiteCode: contains(search) },
        { remarks: contains(search) },
        { outputs: { some: { OR: [
          { serviceCode: contains(search) },
          { sharingCustomerServiceId: contains(search) },
          { sharingCustomerServiceCode: contains(search) },
          { destinationSiteCode: contains(search) },
          { destinationLabel: contains(search) },
          { localOdfCode: contains(search) },
          { localPortLabel: contains(search) },
          { destinationPortLabel: contains(search) },
        ] } } },
      ],
    });
  }
  const site = filters.site?.trim().toUpperCase();
  if (site) {
    and.push({ OR: [
      { primaryInputSiteCode: site },
      { secondaryInputSiteCode: site },
      { outputs: { some: { OR: [{ localSiteCode: site }, { destinationSiteCode: site }] } } },
    ] });
  }
  const type = filters.splitterType?.trim().toUpperCase();
  if (type === "OSP_SPL" || type === "ISP_SPL") {
    and.push({ OR: [{ splitterType: type }, { splitterType: null, scope: type === "ISP_SPL" ? "ISP" : "OSP" }] });
  }
  const status = filters.status?.trim().toUpperCase();
  if (status && status !== "ALL") and.push({ status: status as Prisma.EnumResourceStatusFilter["equals"] });
  return and.length ? { AND: and } : {};
}

/**
 * Protection type structure rule: when the worksheet path direction string
 * joins two unique site names with an ampersand (e.g. "Bousher & Ghala"),
 * the splitter has redundant paths landing on separate physical exchanges
 * and must be flagged PROTECTED even if the imported row never said so.
 */
function derivedProtectionMode(splitter: SplitterRecord): string {
  const stored = String(splitter.protectionMode ?? "UNKNOWN").toUpperCase();
  if (stored !== "UNKNOWN") return stored;
  for (const text of [splitter.locationContext, splitter.location, splitter.splitterName]) {
    const parts = String(text ?? "").split("&").map((part) => part.trim().toUpperCase()).filter(Boolean);
    if (parts.length >= 2 && new Set(parts).size >= 2) return "PROTECTED";
  }
  if (
    splitter.primaryInputSiteCode &&
    splitter.secondaryInputSiteCode &&
    splitter.primaryInputSiteCode !== splitter.secondaryInputSiteCode
  ) {
    return "PROTECTED";
  }
  return stored;
}

function mapOutput(output: SplitterOutputRecord): SplitterOutputRow {
  return {
    id: output.id,
    outputLabel: output.outputLabel,
    outputPort: output.outputPort,
    localSiteCode: output.localSiteCode,
    localRackCode: output.localRackCode,
    localOdfCode: output.localOdfCode,
    localPortLabel: output.localPortLabel,
    destinationSiteCode: output.destinationSiteCode,
    destinationLabel: output.destinationLabel,
    destinationRackCode: output.destinationRackCode,
    destinationOdfCode: output.destinationOdfCode,
    destinationPortLabel: output.destinationPortLabel,
    serviceCode: output.serviceCode,
    sharingCustomerServiceId: output.sharingCustomerServiceId ?? output.sharingCustomerServiceCode ?? null,
    // Backward-compatible alias for older forms and cached browser bundles.
    sharingCustomerServiceCode: output.sharingCustomerServiceCode ?? output.sharingCustomerServiceId ?? null,
    capacityFibers: output.capacityFibers,
    usedFibers: output.usedFibers,
    availableFibers: output.availableFibers,
    status: output.status,
    remarks: output.remarks,
  };
}

function mapSplitter(splitter: SplitterRecord, configuredFromOutputs?: number): SplitterInventoryRow {
  const outputCount = splitter._count?.outputs ?? 0;
  // Utilization metric engine: configured output ports / total physical hardware
  // capacity (e.g. a 1x32 card), independent of how many child records exist.
  const configuredOutputPorts = splitter.configuredOutputPorts > 0
    ? splitter.configuredOutputPorts
    : configuredFromOutputs ?? outputCount;
  const totalHardwareCapacity = splitter.outputPortCapacity ?? Math.max(configuredOutputPorts, outputCount, 0);
  const availableOutputPorts = Math.max(0, totalHardwareCapacity - configuredOutputPorts);
  return {
    id: splitter.id,
    splitterCode: splitter.splitterCode,
    splitterName: splitter.splitterName,
    splitterType: splitter.splitterType ?? `${splitter.scope}_SPL`,
    scope: splitter.scope,
    sourceSite: splitter.primaryInputSiteCode,
    location: splitter.location,
    locationContext: splitter.locationContext ?? splitter.location,
    protectionMode: derivedProtectionMode(splitter),
    primaryInputSiteCode: splitter.primaryInputSiteCode,
    primaryInputRackCode: splitter.primaryInputRackCode,
    primaryInputOdfCode: splitter.primaryInputOdfCode,
    primaryInputPortLabel: splitter.primaryInputPortLabel,
    secondaryInputSiteCode: splitter.secondaryInputSiteCode,
    secondaryInputRackCode: splitter.secondaryInputRackCode,
    secondaryInputOdfCode: splitter.secondaryInputOdfCode,
    secondaryInputPortLabel: splitter.secondaryInputPortLabel,
    outputPortCapacity: splitter.outputPortCapacity,
    configuredOutputPorts,
    totalHardwareCapacity,
    utilizationPct: totalHardwareCapacity > 0 ? Math.round((configuredOutputPorts / totalHardwareCapacity) * 10000) / 100 : 0,
    status: splitter.status,
    outputCount,
    usedFibers: configuredOutputPorts,
    availableFibers: availableOutputPorts,
    source: splitter.source,
    remarks: splitter.remarks,
    outputs: [],
  };
}

export const splitterService = {
  /**
   * Paged parent summaries only — outputs are intentionally NOT loaded here.
   * Child output rows are fetched on demand via listSplitterOutputs when an
   * operator expands a parent row, so 20k splitters / 200k outputs stay fast.
   */
  async listSplittersPage(filters: SplitterListFilters = {}, options: { page?: number; pageSize?: number } = {}): Promise<SplitterListPage> {
    const where = splitterWhere(filters);
    const pageSize = Math.min(Math.max(options.pageSize ?? 100, 25), 1000);
    const page = Math.max(1, options.page ?? 1);
    const [splitters, total] = await Promise.all([
      prisma.splitter.findMany({
        where,
        include: { _count: { select: { outputs: true } } },
        orderBy: [{ scope: "asc" }, { splitterCode: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.splitter.count({ where }),
    ]);
    return { rows: splitters.map((splitter) => mapSplitter(splitter)), total, page, pageSize };
  },

  async getSummary(filters: SplitterListFilters = {}): Promise<SplitterSummary> {
    const where = splitterWhere(filters);
    const [total, osp, outputs, aggregates, fallbackConfigured] = await Promise.all([
      prisma.splitter.count({ where }),
      prisma.splitter.count({ where: { AND: [where, { OR: [{ splitterType: "OSP_SPL" }, { splitterType: null, scope: "OSP" }] }] } }),
      prisma.splitterOutput.count({ where: { splitter: where } }),
      prisma.splitter.aggregate({ where, _sum: { configuredOutputPorts: true, outputPortCapacity: true } }),
      // Rows without an explicit configured count fall back to their live
      // (non-decommissioned) output rows, matching the per-row utilization math.
      prisma.splitterOutput.count({
        where: {
          status: { not: "DECOMMISSIONED" },
          splitter: { AND: [where, { configuredOutputPorts: { lte: 0 } }] },
        },
      }),
    ]);
    const configured = (aggregates._sum.configuredOutputPorts ?? 0) + fallbackConfigured;
    const capacity = aggregates._sum.outputPortCapacity ?? 0;
    return {
      totalSplitters: total,
      ospSplitters: osp,
      ispSplitters: total - osp,
      totalOutputs: outputs,
      configuredPorts: configured,
      availablePorts: Math.max(0, capacity - configured),
    };
  },

  async listSplitterOutputs(splitterId: string): Promise<SplitterOutputRow[]> {
    const outputs = await prisma.splitterOutput.findMany({
      where: { splitterId },
      orderBy: [{ outputPort: "asc" }, { outputLabel: "asc" }, { createdAt: "asc" }],
    });
    return outputs.map(mapOutput);
  },

  /**
   * Full eager load (parents + all outputs). Reserved for server-side export
   * and site drill-down paths; never use for the main inventory page render.
   */
  async listSplitters(filters: SplitterListFilters = {}): Promise<SplitterInventoryRow[]> {
    const where = splitterWhere(filters);
    const splitters = await prisma.splitter.findMany({
      where,
      include: {
        _count: { select: { outputs: true } },
        outputs: { orderBy: [{ outputPort: "asc" }, { outputLabel: "asc" }, { createdAt: "asc" }] },
      },
      orderBy: [{ scope: "asc" }, { splitterCode: "asc" }],
    });
    return splitters.map((splitter) => {
      const activeOutputCount = splitter.outputs.filter((output) => output.status !== "DECOMMISSIONED").length;
      const row = mapSplitter(splitter, activeOutputCount);
      row.outputs = splitter.outputs.map(mapOutput);
      return row;
    });
  },
};
