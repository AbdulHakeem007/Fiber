import { prisma } from "@/lib/db/prisma";
import type { ServiceTraceLinkView } from "@/types/telecom";
import { logRetentionCutoff } from "@/lib/config/log-retention";
import { exportService } from "@/server/services/export.service";
import { impactAnalysisService } from "@/server/services/impact-analysis.service";
import { siteConnectivityService } from "@/server/services/site-connectivity.service";
import { serviceTraceService } from "@/server/services/service-trace.service";
import { splitterService } from "@/server/services/splitter.service";

export interface ExportDataRequest {
  type?: string | null;
  siteCode?: string | null;
  serviceCode?: string | null;
  batchId?: string | null;
  search?: string | null;
  connectedSite?: string | null;
  serviceId?: string | null;
  rackId?: string | null;
  odfId?: string | null;
  portPair?: string | null;
  fiberPortNumber?: string | null;
  cableId?: string | null;
  tubeNumber?: string | null;
  tubeColor?: string | null;
  fiberNumber?: string | null;
  transportTrail?: string | null;
  status?: string | null;
  siteType?: string | null;
  regionPrefix?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  /** Comma-separated service tag filter (e.g. "B2B" or "B2B,Backbone"). */
  tag?: string | null;
}

export interface ExportDataResult {
  rows: Record<string, unknown>[];
  sheetName: string;
  fileName: string;
}

// Complete-inventory and ODF/rack exports must page through ODFs in chunks.
// Loading every ODF with `include: { ports, portGroups }` in one query makes
// Prisma build a relation IN(...) list spanning the whole table; combined with
// the `status: { not: DECOMMISSIONED }` relation filter the query cannot be
// auto-split and SQLite throws "Query parameter limit exceeded".
const ODF_EXPORT_CHUNK = 400;

type OdfExportRecord = Awaited<ReturnType<typeof fetchOdfExportChunk>>[number];

function fetchOdfExportChunk(cursor: string | null) {
  return prisma.oDF.findMany({
    where: { status: { not: "DECOMMISSIONED" } },
    include: {
      site: true,
      rack: true,
      ports: { where: { status: { not: "DECOMMISSIONED" } } },
      portGroups: {
        where: { status: { not: "DECOMMISSIONED" } },
        include: { splitterOutputs: true },
      },
    },
    orderBy: { id: "asc" },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: ODF_EXPORT_CHUNK,
  });
}

async function fetchAllOdfsChunked(): Promise<OdfExportRecord[]> {
  const all: OdfExportRecord[] = [];
  let cursor: string | null = null;
  for (;;) {
    const chunk = await fetchOdfExportChunk(cursor);
    all.push(...chunk);
    if (chunk.length < ODF_EXPORT_CHUNK) break;
    cursor = chunk[chunk.length - 1]?.id ?? null;
    if (!cursor) break;
  }
  // Cursor pagination walks by id; restore the operator-facing sort order.
  all.sort((a, b) =>
    a.site.code.localeCompare(b.site.code) ||
    a.rack.rackCode.localeCompare(b.rack.rackCode) ||
    a.odfCode.localeCompare(b.odfCode),
  );
  return all;
}

function parseJsonObject(value?: string | null): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function rowIncludes(row: Record<string, unknown>, value?: string | null): boolean {
  const query = value?.trim().toUpperCase();
  if (!query) return true;
  return Object.values(row).filter(Boolean).join(" ").toUpperCase().includes(query);
}

function filterTraceRows(rows: Record<string, unknown>[], input: ExportDataRequest): Record<string, unknown>[] {
  return rows.filter((row) =>
    rowIncludes(row, input.search) &&
    (!input.siteCode || rowIncludes({ siteCode: row.siteCode, fullPathLabel: row.fullPathLabel }, input.siteCode)) &&
    (!input.rackId || rowIncludes({ incomingRackCode: row.incomingRackCode, outgoingRackCode: row.outgoingRackCode }, input.rackId)) &&
    (!input.odfId || rowIncludes({ incomingOdfCode: row.incomingOdfCode, outgoingOdfCode: row.outgoingOdfCode }, input.odfId)) &&
    (!input.portPair || rowIncludes({ incomingPortGroup: row.incomingPortGroup, outgoingPortGroup: row.outgoingPortGroup }, input.portPair)) &&
    (!input.tubeNumber || String(row.incomingTubeNumber ?? row.outgoingTubeNumber ?? "") === input.tubeNumber) &&
    (!input.tubeColor || rowIncludes({ incomingTubeColor: row.incomingTubeColor, outgoingTubeColor: row.outgoingTubeColor }, input.tubeColor)) &&
    (!input.fiberPortNumber || String(row.incomingFiberPortNumber ?? row.outgoingFiberPortNumber ?? "") === input.fiberPortNumber) &&
    (!input.fiberNumber || String(row.incomingFiberNumber ?? row.outgoingFiberNumber ?? "") === input.fiberNumber)
  );
}

function selectedScope(input: ExportDataRequest): string {
  const scope = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== ""),
  );
  return JSON.stringify(scope);
}

function withExportMetadata(rows: Record<string, unknown>[], input: ExportDataRequest, type: string) {
  const exportedAt = new Date().toISOString();
  const scope = selectedScope(input);
  return rows.map((row) => ({
    exportedAt,
    exportType: type,
    selectedScope: scope,
    ...row,
  }));
}

// Trace/Provision exports read top-to-bottom as a directional circuit path:
// the service's start site belongs in the FIRST row's "Near Site ID" and the
// terminal site in the LAST row's "Far Site ID". A trace can emit the final
// segment reversed — the ultimate end-site lands in the "Near" column — which
// breaks that reading flow (e.g. terminal BA0001/SOHAREXCHANGE rendering as a
// Near Site). These pairs are swapped together so each endpoint's identity
// (site, rack, ODF, port) and its available-port count stay aligned. The
// structural "Segment Name" identifier is intentionally never touched.
const TRACE_NEAR_FAR_SWAP_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["Near Site ID", "Far Site ID"],
  ["Near Rack ID", "Far Rack ID"],
  ["Near ODF ID", "Far ODF ID"],
  ["Near Port ID", "Far Port ID"],
  ["Near site Available ports: (Count of ports)", "Far site Available ports: (Count of ports)"],
];

/** Normalize a site label for chain comparison (drops the "(Jumper)" marker). */
function normalizeTraceSiteToken(value: unknown): string {
  return String(value ?? "").replace(/\(\s*jumper\s*\)/gi, "").trim().toUpperCase();
}

function swapTraceRowNearFar(row: Record<string, unknown>): void {
  for (const [near, far] of TRACE_NEAR_FAR_SWAP_PAIRS) {
    const temp = row[near];
    row[near] = row[far];
    row[far] = temp;
  }
}

/**
 * Re-orient trace rows so the path reads start -> ... -> terminal end-to-end.
 * Uses conservative chain-continuity detection: a row is only flipped when the
 * chain provably continues out of the wrong column, so correctly oriented rows
 * (and non-linear topologies) are left untouched.
 */
function orientTraceExportRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (rows.length < 2) return rows;

  // First row: the service's start site must sit in "Near Site ID". If the
  // continuation (the site shared with row 2) is in this row's Near column and
  // the unique start site is in its Far column, the first row is reversed.
  const first = rows[0];
  const second = rows[1];
  const firstNear = normalizeTraceSiteToken(first["Near Site ID"]);
  const firstFar = normalizeTraceSiteToken(first["Far Site ID"]);
  const secondNear = normalizeTraceSiteToken(second["Near Site ID"]);
  const secondFar = normalizeTraceSiteToken(second["Far Site ID"]);
  const firstContinuationInNear = Boolean(firstNear) && (firstNear === secondNear || firstNear === secondFar);
  const firstStartInFar = Boolean(firstFar) && firstFar !== secondNear && firstFar !== secondFar;
  if (firstContinuationInNear && firstStartInFar) swapTraceRowNearFar(first);

  // Last row: the terminal site must sit in "Far Site ID". If the chain
  // continues out of this row's Far column (matching the previous row's far
  // site) while the distinct terminal site is stranded in its Near column,
  // swap so the end-site lands in the final "Far Site ID".
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const prevFar = normalizeTraceSiteToken(prev["Far Site ID"]);
  const lastNear = normalizeTraceSiteToken(last["Near Site ID"]);
  const lastFar = normalizeTraceSiteToken(last["Far Site ID"]);
  if (prevFar && lastFar === prevFar && lastNear && lastNear !== prevFar) swapTraceRowNearFar(last);

  return rows;
}

export const exportDataService = {
  async buildRows(input: ExportDataRequest): Promise<ExportDataResult> {
    const type = input.type ?? "inventory";
    const tagFilters = String(input.tag ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    // Tag-based ODF Mapping export: when a service tag (e.g. B2B) is selected,
    // every child ODF mapping carrying that tag is exported across the ENTIRE
    // network. The query rides the dedicated @@index([tag]) column, so it stays
    // flat even at the 200k-child-row scale target.
    if (type === "odf-mappings-by-tag") {
      if (!tagFilters.length) {
        throw new Error("Select at least one service tag (e.g. B2B) before exporting tag-filtered ODF Mappings.");
      }
      const mappings = await prisma.segmentEndpointMapping.findMany({
        where: {
          tag: { in: tagFilters },
          status: { not: "DECOMMISSIONED" },
          segment: { status: { not: "DECOMMISSIONED" } },
        },
        include: {
          segment: { select: { segmentCode: true, segmentGroupName: true, distanceKm: true, status: true } },
        },
        orderBy: [{ tag: "asc" }, { localSiteCode: "asc" }, { localOdfCode: "asc" }, { localPortLabel: "asc" }],
      });
      return {
        sheetName: "Tagged ODF Mappings",
        fileName: `odf-mappings-tag-${tagFilters.join("-").toLowerCase().replace(/[^a-z0-9-]+/g, "")}.xlsx`,
        rows: withExportMetadata(mappings.map((mapping, index) => ({
          "Sr.No": index + 1,
          "Service Tag": mapping.tag,
          "Service ID": mapping.serviceCode ?? "-",
          "Segment Name": mapping.segment.segmentCode,
          "Segment Group": mapping.segment.segmentGroupName ?? "-",
          "Near Site ID": mapping.localSiteCode ?? "-",
          "Near Rack ID": mapping.localRackCode ?? "-",
          "Near ODF ID": mapping.localOdfCode ?? "-",
          "Near Port ID": mapping.localPortLabel ?? "-",
          "Far Site ID": mapping.farSiteCode ?? mapping.farEndpointLabel ?? "-",
          "Far Rack ID": mapping.farRackCode ?? "-",
          "Far ODF ID": mapping.farOdfCode ?? "-",
          "Far Port ID": mapping.farPortLabel ?? "-",
          "Topology Role": mapping.childTopologyRole ?? "-",
          "Distance (km)": mapping.segment.distanceKm ?? "-",
          "Status": mapping.status,
          "Remarks": mapping.remarks ?? "-",
        })), input, type),
      };
    }

    // Full activity-log ledger export. The online panel only shows the most
    // recent 15 days; this compiles the complete retained window (>= 6 months)
    // into a downloadable workbook so nothing is lost from the UI cap.
    if (type === "audit-logs") {
      const cutoff = logRetentionCutoff();
      const logs = await prisma.auditLog.findMany({
        where: { createdAt: { gte: cutoff } },
        include: { changedBy: { select: { name: true, email: true } } },
        orderBy: { createdAt: "desc" },
      });
      return {
        sheetName: "Activity Logs",
        fileName: `activity-logs-${cutoff.toISOString().slice(0, 10)}-to-${new Date().toISOString().slice(0, 10)}.xlsx`,
        rows: withExportMetadata(logs.map((log, index) => ({
          "Sr.No": index + 1,
          "When": log.createdAt.toISOString(),
          "Operator": log.changedBy?.name ?? log.changedBy?.email ?? "System",
          "Action": log.action,
          "Entity Type": log.entityType,
          "Entity ID": log.entityId,
          "Field": log.fieldName ?? "-",
          "Old Value": log.oldValue ?? "-",
          "New Value": log.newValue ?? "-",
          "Reason": log.reason ?? "-",
          "Comment": log.comment ?? "-",
          "Import Batch": log.importBatchId ?? "-",
          "IP Address": log.ipAddress ?? "-",
        })), input, type),
      };
    }

    if (type === "trace") {
      const service = input.serviceCode?.trim();
      if (!service) {
        throw new Error("Service trace export requires a selected service ID.");
      }
      const trace = await serviceTraceService.getTrace(service);
      const calculationTime = new Date().toISOString();
      // Jumper sites: the trace marks each pass-through hop with isJumper, and each
      // topology group lists its own jumper nodes. Append "(Jumper)" to that
      // SPECIFIC Site ID only (e.g. "C" -> "C(Jumper)"), never to the whole
      // segment, so a chain A -> B -> C -> D exports C as "C(Jumper)".
      const jumperSiteCodes = new Set(
        (trace?.hops ?? [])
          .filter((hop) => hop.isJumper)
          .map((hop) => String(hop.siteCode ?? "").trim().toUpperCase())
          .filter(Boolean),
      );
      const allTraceGroups = [
        trace?.mainRingPath,
        ...(trace?.attachedSubrings ?? []),
        ...(trace?.attachedSpurs ?? []),
        ...(trace?.attachedSpurChains ?? []),
        ...(trace?.attachedSingleHomed ?? []),
        ...(trace?.attachedInterconnects ?? []),
      ];
      for (const group of allTraceGroups) {
        for (const jumper of group?.jumpers ?? []) {
          const code = normalizeTraceSiteToken(jumper);
          if (code) jumperSiteCodes.add(code);
        }
      }
      const markJumperSite = (code?: string | null) => {
        const value = String(code ?? "").trim();
        if (!value || value === "-") return value || "-";
        return jumperSiteCodes.has(normalizeTraceSiteToken(value)) ? `${value}(Jumper)` : value;
      };
      let srNo = 0;
      const linkRow = (link: ServiceTraceLinkView) => ({
        "Sr.No": (srNo += 1),
        "Service Trace time Calculation Time": calculationTime,
        "Segment Name": link.segmentCode ?? "-",
        "Impact Type": "Direct",
        "Service ID": link.serviceId ?? trace?.serviceCode ?? service,
        "Near Site ID": markJumperSite(link.local?.siteCode ?? link.localSite),
        "Near Rack ID": link.local?.rackCode ?? "-",
        "Near ODF ID": link.local?.odfCode ?? "-",
        "Near Port ID": link.localPort ?? link.local?.portGroupLabel ?? "-",
        "Near site Available ports: (Count of ports)": link.local?.availableFibers ?? 0,
        "Far Site ID": markJumperSite(link.far?.siteCode ?? link.farSite),
        "Far Rack ID": link.far?.rackCode ?? "-",
        "Far ODF ID": link.far?.odfCode ?? "-",
        "Far Port ID": link.farPort ?? link.far?.portGroupLabel ?? "-",
        "Far site Available ports: (Count of ports)": link.far?.availableFibers ?? 0,
      });

      // ── Structural data isolation ──────────────────────────────────────────
      // Secondary structures (Subrings, Spurs, Spur Chains) must NEVER mix into
      // the Main Ring table. Their link rows are pulled out of the flat list and
      // re-emitted beneath the main table, each under a blank row + a dynamic
      // section heading of the form ServiceID(SR1-Host), ServiceID(Spur1-Host),
      // ServiceID(Spur chain1-Host). The heading names the main-ring host node(s)
      // where the structure terminates; a second structure on the same anchor
      // points increments the index (SR2-...).
      const serviceId = trace?.serviceCode ?? service;
      const mainNodeKeys = new Set((trace?.mainRingPath?.nodes ?? []).map(normalizeTraceSiteToken).filter(Boolean));
      const hostNodesFor = (group: { nodes: string[] }): string[] => {
        const seen = new Set<string>();
        const hosts: string[] = [];
        for (const node of group.nodes) {
          const key = normalizeTraceSiteToken(node);
          if (!key || !mainNodeKeys.has(key) || seen.has(key)) continue;
          seen.add(key);
          hosts.push(String(node).replace(/\(\s*jumper\s*\)/gi, "").trim());
        }
        return hosts;
      };
      const indexByAnchor = new Map<string, number>();
      const sectionHeading = (prefix: string, hosts: string[]): string => {
        const anchorKey = `${prefix}|${hosts.map((host) => host.toUpperCase()).join("-")}`;
        const nextIndex = (indexByAnchor.get(anchorKey) ?? 0) + 1;
        indexByAnchor.set(anchorKey, nextIndex);
        const hostPart = hosts.length ? `-${hosts.join("-")}` : "";
        return `${serviceId}(${prefix}${nextIndex}${hostPart})`;
      };
      const secondaryGroups = [
        ...(trace?.attachedSubrings ?? []).map((group) => ({ prefix: "SR", group })),
        ...(trace?.attachedSpurs ?? []).map((group) => ({ prefix: "Spur", group })),
        ...(trace?.attachedSpurChains ?? []).map((group) => ({ prefix: "Spur chain", group })),
      ].filter(({ group }) => (group.links?.length ?? 0) > 0);
      const secondaryLinkIds = new Set(secondaryGroups.flatMap(({ group }) => (group.links ?? []).map((link) => link.id)));
      // A group's links array can miss its ring-CLOSING segment (e.g. the
      // last-subring-node -> host uplink), which would otherwise leak into the
      // main table. Any link touching one of a group's child (non-main-ring)
      // nodes belongs to that group's section.
      const groupChildKeys = secondaryGroups.map(({ group }) =>
        new Set(group.nodes.map(normalizeTraceSiteToken).filter((key) => key && !mainNodeKeys.has(key))),
      );
      const linkSiteKeys = (link: ServiceTraceLinkView): string[] => [
        normalizeTraceSiteToken(link.local?.siteCode ?? link.localSite),
        normalizeTraceSiteToken(link.far?.siteCode ?? link.farSite),
      ];
      const claimedByGroup = (link: ServiceTraceLinkView): number =>
        groupChildKeys.findIndex((childKeys) => linkSiteKeys(link).some((key) => key && childKeys.has(key)));

      const mainLinks: ServiceTraceLinkView[] = [];
      const extraGroupLinks = new Map<number, ServiceTraceLinkView[]>();
      for (const link of trace?.serviceLinks ?? []) {
        if (secondaryLinkIds.has(link.id)) continue; // emitted with its own group below
        const groupIndex = claimedByGroup(link);
        if (groupIndex >= 0) {
          extraGroupLinks.set(groupIndex, [...(extraGroupLinks.get(groupIndex) ?? []), link]);
        } else {
          mainLinks.push(link);
        }
      }

      const rows: Record<string, unknown>[] = orientTraceExportRows(mainLinks.map(linkRow));
      secondaryGroups.forEach(({ prefix, group }, groupIndex) => {
        rows.push({}); // blank separator row
        rows.push({ "Sr.No": sectionHeading(prefix, hostNodesFor(group)) }); // section heading row
        for (const link of group.links ?? []) rows.push(linkRow(link));
        for (const link of extraGroupLinks.get(groupIndex) ?? []) rows.push(linkRow(link));
      });

      return {
        rows,
        sheetName: "Trace and Provision",
        fileName: `${service}-trace-and-provision.xlsx`,
      };
    }

    // Site-to-site transport trail / INDIRECT trace export. Mirrors the on-screen
    // Transport Trail Preview: every discovered route (primary first, then the
    // alternatives ascending by hop count) exports as its own section with
    // positional (Jumper) marking on transit sites, followed by the physical
    // segment-detail table for the resolved path.
    if (type === "trace-path") {
      const trail = input.transportTrail?.trim();
      if (!trail) {
        throw new Error("Trace path export requires the transport trail (e.g. SITE-A -> SITE-B).");
      }
      const preview = await serviceTraceService.previewTransportPath(trail);
      const calculationTime = new Date().toISOString();
      const rows: Record<string, unknown>[] = [];
      let srNo = 0;

      const routeSection = (heading: string, summary: { path: Array<{ siteId: string; siteName: string; availablePortsCount: number; segmentDistance: number; isJumper: boolean }>; cumulativeDistance: number }) => {
        if (rows.length) rows.push({});
        rows.push({ "Sr.No": heading });
        let cumulativeKm = 0;
        for (const hop of summary.path) {
          cumulativeKm = Math.round((cumulativeKm + (hop.segmentDistance ?? 0)) * 100) / 100;
          rows.push({
            "Sr.No": (srNo += 1),
            "Trace Calculation Time": calculationTime,
            "Site ID": hop.isJumper ? `${hop.siteId}(Jumper)` : hop.siteId,
            "Site Name": hop.siteName ?? hop.siteId,
            "Available Ports": hop.availablePortsCount ?? 0,
            "Segment Distance (km)": hop.segmentDistance ?? 0,
            "Cumulative Distance (km)": cumulativeKm,
          });
        }
      };

      if (preview.indirectRouteSummary) {
        const primary = preview.indirectRouteSummary;
        routeSection(`Primary Route (${Math.max(0, primary.path.length - 1)} hops, ${primary.cumulativeDistance} km)`, primary);
        (preview.alternativeRouteSummaries ?? []).forEach((alternative, index) => {
          routeSection(`Alternative Route ${index + 2} (${Math.max(0, alternative.path.length - 1)} hops, ${alternative.cumulativeDistance} km)`, alternative);
        });
      }

      // Physical segment details of the resolved path (direct trails export only this).
      if (preview.hops.length) {
        if (rows.length) rows.push({});
        rows.push({ "Sr.No": `Segment Details (${preview.matchedHops} matched / ${preview.missingHops} missing, ${preview.totalDistanceKm} km)` });
        for (const hop of preview.hops) {
          rows.push({
            "Sr.No": (srNo += 1),
            "Trace Calculation Time": calculationTime,
            "Near Site ID": hop.from,
            "Far Site ID": hop.to,
            "Segment Name": hop.segmentCode ?? (hop.matched ? "-" : "No matching segment"),
            "Service IDs": hop.serviceIds ?? "-",
            "Used / Total Fibers": hop.totalFibers == null ? "-" : `${hop.usedFibers ?? 0} / ${hop.totalFibers}`,
            "Available Ports": hop.availableFibers ?? "-",
            "Status": hop.status ?? "-",
            "Segment Distance (km)": hop.distanceKm ?? "-",
            "Cumulative Distance (km)": hop.cumulativeDistanceKm ?? "-",
          });
        }
      }

      const slug = trail.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).toLowerCase() || "trace-path";
      return {
        rows,
        sheetName: "Trace Path",
        fileName: `trace-path-${slug}.xlsx`,
      };
    }

    if (type === "alerts") {
      const alerts = await prisma.alertEvent.findMany({
        orderBy: [{ lastSeenAt: "desc" }],
      });
      return {
        sheetName: "Alerts",
        fileName: "alerts-export.xlsx",
        rows: withExportMetadata(alerts.map((alert) => ({
          title: alert.title,
          alertType: alert.alertType,
          severity: alert.severity,
          state: alert.state,
          sitePairKey: alert.sitePairKey,
          message: alert.message,
          firstSeenAt: alert.firstSeenAt.toISOString(),
          lastSeenAt: alert.lastSeenAt.toISOString(),
        })), input, type),
      };
    }

    if (type === "impact") {
      const summary = await impactAnalysisService.analyze({
        search: input.search ?? undefined,
        site: input.siteCode ?? undefined,
        connectedSite: input.connectedSite ?? undefined,
        serviceId: input.serviceId ?? undefined,
        rackId: input.rackId ?? undefined,
        odfId: input.odfId ?? undefined,
        portPair: input.portPair ?? undefined,
        fiberPortNumber: input.fiberPortNumber ?? undefined,
        cableId: input.cableId ?? undefined,
        tubeNumber: input.tubeNumber ?? undefined,
        tubeColor: input.tubeColor ?? undefined,
        fiberNumber: input.fiberNumber ?? undefined,
        transportTrail: input.transportTrail ?? undefined,
        status: input.status ?? undefined,
        siteType: input.siteType ?? undefined,
        regionPrefix: input.regionPrefix ?? undefined,
        dateFrom: input.dateFrom ?? undefined,
        dateTo: input.dateTo ?? undefined,
      });
      return {
        rows: summary.exportRows.map((row, index) => ({
          "Sr.No": index + 1,
          "Impact Calculation Time": row.impactCalculationTime ?? row["Impact calculation time"] ?? new Date().toISOString(),
          "Segment Name": row.segmentCode ?? row["Segment code"] ?? "-",
          "Impact Type": row.impactSection ?? row["Impact Section"] ?? "Direct",
          "Service ID": row.serviceId ?? row["Service ID"] ?? "-",
          "Near Site ID": row.nearSite ?? row["Near site"] ?? "-",
          "Near Rack ID": row.nearRack ?? row["Near rack"] ?? "-",
          "Near ODF ID": row.nearOdf ?? row["Near ODF"] ?? "-",
          "Near Port ID": row.nearPort ?? row["Near port"] ?? "-",
          "Far Site ID": row.farSite ?? row["Far site"] ?? "-",
          "Far Rack ID": row.farRack ?? row["Far rack"] ?? "-",
          "Far ODF ID": row.farOdf ?? row["Far ODF"] ?? "-",
          "Far Port ID": row.farPort ?? row["Far port"] ?? "-",
        })),
        sheetName: "Impact Analysis",
        fileName: "impact-analysis-export.xlsx",
      };
    }

    if (type === "impact-e2e") {
      // Deep Impact Export: the on-screen impact view deliberately shows only
      // directly connected sites / local counts for performance. This explicit
      // export maps the selected Rack ID / ODF ID to EVERY active service
      // running through them and prints each service's full end-to-end (A-to-Z)
      // transport path chain, traced across the whole network — not just the
      // local segment hop.
      const summary = await impactAnalysisService.analyze({
        search: input.search ?? undefined,
        site: input.siteCode ?? undefined,
        connectedSite: input.connectedSite ?? undefined,
        serviceId: input.serviceId ?? undefined,
        rackId: input.rackId ?? undefined,
        odfId: input.odfId ?? undefined,
        portPair: input.portPair ?? undefined,
        fiberPortNumber: input.fiberPortNumber ?? undefined,
        cableId: input.cableId ?? undefined,
        tubeNumber: input.tubeNumber ?? undefined,
        tubeColor: input.tubeColor ?? undefined,
        fiberNumber: input.fiberNumber ?? undefined,
        transportTrail: input.transportTrail ?? undefined,
        status: input.status ?? undefined,
        siteType: input.siteType ?? undefined,
        regionPrefix: input.regionPrefix ?? undefined,
        dateFrom: input.dateFrom ?? undefined,
        dateTo: input.dateTo ?? undefined,
      });

      // One full A-to-Z trace per distinct service (not per link row).
      const serviceIds = [...new Set(
        summary.activeServiceLinks.map((link) => String(link.serviceId ?? "").trim()).filter(Boolean),
      )];
      const chainByService = new Map<string, { chain: string; distanceKm: number | null }>();
      for (const serviceId of serviceIds) {
        try {
          const trace = await serviceTraceService.getTraceCore(serviceId);
          if (trace?.fullPathLabel) {
            chainByService.set(serviceId, { chain: trace.fullPathLabel, distanceKm: trace.totalDistanceKm ?? null });
          }
        } catch {
          // A single failed trace must not sink the whole export; the row
          // falls back to the in-scope site set below.
        }
      }

      const calculationTime = new Date().toISOString();
      const rows = summary.activeServiceLinks.map((link, index) => {
        const traced = chainByService.get(String(link.serviceId ?? "").trim());
        const scopedTrail = summary.impactedServices.find((service) => service.serviceCode === link.serviceId)?.fullPathLabel;
        return {
          "Sr.No": index + 1,
          "Impact Calculation Time": calculationTime,
          "Selected Site ID": input.siteCode ?? "-",
          "Selected Rack ID": input.rackId ?? "-",
          "Selected ODF ID": input.odfId ?? "-",
          "Impact Type": link.section,
          "Service ID": link.serviceId,
          "Segment Name": link.segmentCode,
          "Near Site ID": link.nearSite ?? "-",
          "Near Rack ID": link.nearRack ?? "-",
          "Near ODF ID": link.nearOdf ?? "-",
          "Near Port ID": link.nearPort ?? "-",
          "Far Site ID": link.farSite ?? "-",
          "Far Rack ID": link.farRack ?? "-",
          "Far ODF ID": link.farOdf ?? "-",
          "Far Port ID": link.farPort ?? "-",
          "End-to-End Transport Chain (A-Z)": traced?.chain ?? scopedTrail ?? "-",
          "E2E Distance (km)": traced?.distanceKm ?? "-",
          "Status": link.status ?? "-",
        };
      });

      return {
        rows,
        sheetName: "Impact Export E2E",
        fileName: "impact-export-e2e-transport-chains.xlsx",
      };
    }

    if (type === "site-connectivity") {
      const summary = input.siteCode ? await siteConnectivityService.getForSite(input.siteCode) : null;
      return {
        sheetName: "Site Connectivity",
        fileName: `${input.siteCode ?? "site"}-connectivity.xlsx`,
        rows: withExportMetadata(summary
          ? summary.rows.map((row) => ({
              searchedSite: row.searchedSite,
              connectedSite: row.connectedSite,
              directSegmentCount: row.directSegmentCount,
              segmentCode: row.segmentCode,
              rackId: row.rackId,
              odfId: row.odfId,
              portPair: row.portPair,
              farRackId: row.farRackId,
              farOdfId: row.farOdfId,
              farPortPair: row.farPortPair,
              cableId: row.cableId,
              tubeNumber: row.tubeNumber,
              tubeColor: row.tubeColor,
              fiberPortNumber: row.fiberPortNumber,
              fiberNumber: row.fiberNumber,
              distanceKm: row.distanceKm,
              utilizationPct: row.utilizationPct,
              serviceIds: row.serviceIds,
              serviceCount: row.serviceCount,
              status: row.status,
            }))
          : [], input, type),
      };
    }

    if (type === "splitters") {
      const splitters = await splitterService.listSplitters();
      return {
        sheetName: "Splitters",
        fileName: "splitters-export.xlsx",
        rows: withExportMetadata(splitters.flatMap((splitter) =>
          splitter.outputs.length
            ? splitter.outputs.map((output) => ({
                splitterCode: splitter.splitterCode,
                splitterName: splitter.splitterName,
                scope: splitter.scope,
                location: splitter.location,
                protectionMode: splitter.protectionMode,
                primaryInput: [splitter.primaryInputSiteCode, splitter.primaryInputRackCode, splitter.primaryInputOdfCode, splitter.primaryInputPortLabel].filter(Boolean).join(" / "),
                outputLabel: output.outputLabel,
                localOdfPort: [output.localSiteCode, output.localRackCode, output.localOdfCode, output.localPortLabel].filter(Boolean).join(" / "),
                destination: output.destinationSiteCode ?? output.destinationLabel,
                destinationOdfPort: [output.destinationRackCode, output.destinationOdfCode, output.destinationPortLabel].filter(Boolean).join(" / "),
                serviceCode: output.serviceCode,
                capacityFibers: output.capacityFibers,
                usedFibers: output.usedFibers,
                availableFibers: output.availableFibers,
                outputStatus: output.status,
              }))
            : [{
                splitterCode: splitter.splitterCode,
                splitterName: splitter.splitterName,
                scope: splitter.scope,
                location: splitter.location,
                protectionMode: splitter.protectionMode,
                primaryInput: [splitter.primaryInputSiteCode, splitter.primaryInputRackCode, splitter.primaryInputOdfCode, splitter.primaryInputPortLabel].filter(Boolean).join(" / "),
                outputStatus: splitter.status,
              }]
        ), input, type),
      };
    }

    if (type === "odf-racks") {
      const odfs = await fetchAllOdfsChunked();
      return {
        sheetName: "ODF Racks",
        fileName: "odf-racks-export.xlsx",
        rows: withExportMetadata(odfs.map((odf) => ({
          siteCode: odf.site.code,
          rackCode: odf.rack.rackCode,
          odfCode: odf.odfCode,
          status: odf.status,
          maxPorts: odf.maxPorts,
          totalOdfPorts: odf.ports.length,
          usedOdfPorts: odf.ports.filter((port) => port.status === "USED" || port.status === "ACTIVE").length,
          freeOdfPorts: odf.ports.filter((port) => port.status === "AVAILABLE" || port.status === "SPARE").length,
          dummyOdfPorts: odf.ports.filter((port) => port.status === "DUMMY").length,
          reservedOdfPorts: odf.ports.filter((port) => port.status === "RESERVED").length,
          faultyOdfPorts: odf.ports.filter((port) => port.status === "FAULTY").length,
          portGroups: odf.portGroups.length,
          splitterOutputPortGroups: odf.portGroups.filter((group) => group.splitterOutputs.length > 0).length,
          remarks: odf.remarks,
        })), input, type),
      };
    }

    if (type === "import") {
      const stagingRows = await prisma.importStagingRow.findMany({
        where: input.batchId ? { importBatchId: input.batchId } : undefined,
        orderBy: { rowNumber: "asc" },
        include: {
          importBatch: { select: { batchCode: true, fileName: true } },
          issues: { select: { severity: true, issueCode: true, message: true } },
        },
      });

      return {
        sheetName: "Import Review",
        fileName: "import-review-export.xlsx",
        rows: withExportMetadata(stagingRows.map((row) => {
          const normalized = parseJsonObject(row.normalizedJson);
          const raw = parseJsonObject(row.rawJson);
          return {
            batchCode: row.importBatch.batchCode,
            fileName: row.importBatch.fileName,
            rowNumber: row.rowNumber,
            status: row.status,
            sourceSheet: normalized.sourceSheet,
            sourceSiteRaw: normalized.sourceSiteRaw,
            sourceSite: normalized.sourceSiteCanonical,
            rackCode: normalized.rackCode,
            odfCode: normalized.odfCode,
            portGroupLabel: normalized.portGroupLabel,
            farSiteRaw: normalized.farSiteRaw,
            farSite: normalized.farSiteCanonical,
            directionText: normalized.directionText,
            definitionText: normalized.definitionText,
            rawSourceRow: JSON.stringify(raw),
            normalizedRow: JSON.stringify(normalized),
            issues: row.issues.map((issue) => `${issue.severity}:${issue.issueCode}`).join(", "),
          };
        }), input, type),
      };
    }

    if (type === "complete-inventory") {
      const odfs = await fetchAllOdfsChunked();
      const splitters = await splitterService.listSplitters();
      const odfMappingRows = await exportService.buildInventoryExportRows(input.siteCode ?? undefined, {
        search: input.search ?? undefined,
        site: input.siteCode ?? undefined,
        connectedSite: input.connectedSite ?? undefined,
        serviceId: input.serviceId ?? undefined,
        rackId: input.rackId ?? undefined,
        odfId: input.odfId ?? undefined,
        portPair: input.portPair ?? undefined,
        status: input.status ?? undefined,
      });

      const rows = [
        ...odfMappingRows.map((row) => ({
          inventorySection: "ODF Mapping",
          siteCode: row.nearSite,
          rackId: row.nearRack,
          odfId: row.nearOdf,
          portId: row.nearPortGroup,
          farSiteCode: row.farSite,
          farRackId: row.farRack,
          farOdfId: row.farOdf,
          farPortId: row.farPortGroup,
          segmentName: row.segmentCode,
          serviceId: row.serviceIds,
          status: row.status,
        })),
        ...odfs.map((odf) => ({
          inventorySection: "ODF Rack",
          siteCode: odf.site.code,
          rackId: odf.rack.rackCode,
          odfId: odf.odfCode,
          portId: "ALL",
          farSiteCode: "-",
          farRackId: "-",
          farOdfId: "-",
          farPortId: "-",
          segmentName: "-",
          serviceId: "-",
          status: odf.status,
          totalOdfPorts: odf.ports.length,
          odfPortGroups: odf.portGroups.length,
        })),
        ...splitters.flatMap((splitter) => splitter.outputs.length ? splitter.outputs.map((output) => ({
          inventorySection: "Splitter",
          siteCode: splitter.primaryInputSiteCode ?? "-",
          rackId: splitter.primaryInputRackCode ?? "-",
          odfId: splitter.primaryInputOdfCode ?? "-",
          portId: splitter.primaryInputPortLabel ?? "-",
          farSiteCode: output.destinationSiteCode ?? output.destinationLabel ?? "-",
          farRackId: output.destinationRackCode ?? "-",
          farOdfId: output.destinationOdfCode ?? "-",
          farPortId: output.destinationPortLabel ?? "-",
          segmentName: splitter.splitterCode,
          serviceId: output.serviceCode ?? "-",
          status: output.status,
        })) : [{
          inventorySection: "Splitter",
          siteCode: splitter.primaryInputSiteCode ?? "-",
          rackId: splitter.primaryInputRackCode ?? "-",
          odfId: splitter.primaryInputOdfCode ?? "-",
          portId: splitter.primaryInputPortLabel ?? "-",
          farSiteCode: "-",
          farRackId: "-",
          farOdfId: "-",
          farPortId: "-",
          segmentName: splitter.splitterCode,
          serviceId: "-",
          status: splitter.status,
        }]),
      ];

      return {
        rows: withExportMetadata(rows, input, type),
        sheetName: "Complete Inventory",
        fileName: "complete-fiber-inventory-export.xlsx",
      };
    }

    return {
      rows: withExportMetadata(await exportService.buildInventoryExportRows(input.siteCode ?? undefined, {
        search: input.search ?? undefined,
        site: input.siteCode ?? undefined,
        connectedSite: input.connectedSite ?? undefined,
        serviceId: input.serviceId ?? undefined,
        rackId: input.rackId ?? undefined,
        odfId: input.odfId ?? undefined,
        portPair: input.portPair ?? undefined,
        fiberPortNumber: input.fiberPortNumber ?? undefined,
        cableId: input.cableId ?? undefined,
        tubeNumber: input.tubeNumber ?? undefined,
        tubeColor: input.tubeColor ?? undefined,
        fiberNumber: input.fiberNumber ?? undefined,
        transportTrail: input.transportTrail ?? undefined,
        status: input.status ?? undefined,
        siteType: input.siteType ?? undefined,
        regionPrefix: input.regionPrefix ?? undefined,
        dateFrom: input.dateFrom ?? undefined,
        dateTo: input.dateTo ?? undefined,
      }), input, type),
      sheetName: "Inventory",
      fileName: "inventory-export.xlsx",
    };
  },
};
