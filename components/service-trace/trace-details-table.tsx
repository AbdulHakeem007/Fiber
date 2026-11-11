import { Fragment, memo } from "react";
import type { ServiceTraceLinkView, ServiceTraceResult } from "@/types/telecom";
import { topologyRoleLabel, topologyRoleSourceLabel } from "@/lib/telecom/topology-role";

// Human-readable physical link name (e.g. "MU2587-MU1401") instead of the cryptic
// internal segment code (e.g. "ZRING-S1"). Falls back to the code only if the
// near/far site labels are missing.
function readableSegmentName(link: ServiceTraceLinkView): string {
  const near = String(link.localSite ?? "").trim();
  const far = String(link.farSite ?? "").trim();
  return near && far ? `${near}-${far}` : (link.segmentCode ?? "-");
}

function segmentSummary(serviceLinks: ServiceTraceLinkView[]) {
  const bySegment = new Map<string, { segment: string; used: number; available: number }>();
  for (const link of serviceLinks) {
    const key = link.segmentId || link.segmentCode || "UNKNOWN";
    const current = bySegment.get(key) ?? { segment: readableSegmentName(link), used: 0, available: 0 };
    // EDIT HERE: Available is bound to live ODF Mapping segment capacity, not inferred from the service-link row status.
    current.used = Math.max(current.used, Number(link.local?.usedFibers ?? link.far?.usedFibers ?? 0));
    current.available = Math.max(current.available, Number(link.local?.availableFibers ?? link.far?.availableFibers ?? 0));
    bySegment.set(key, current);
  }
  return [...bySegment.values()];
}

function rack(link: ServiceTraceLinkView, side: "near" | "far") {
  return side === "near" ? link.local?.rackCode ?? "-" : link.far?.rackCode ?? "-";
}

function odf(link: ServiceTraceLinkView, side: "near" | "far") {
  return side === "near" ? link.local?.odfCode ?? "-" : link.far?.odfCode ?? "-";
}

function port(link: ServiceTraceLinkView, side: "near" | "far") {
  return side === "near" ? link.localPort ?? link.local?.portGroupLabel ?? "-" : link.farPort ?? link.far?.portGroupLabel ?? "-";
}

function roleBadgeClass(role?: string | null) {
  return `badge topology-role-${String(role ?? "MAIN_RING").toLowerCase().replace(/_/g, "-")}`;
}

function ServiceLinkRows({ links, startIndex }: { links: ServiceTraceLinkView[]; startIndex: number }) {
  return (
    <>
      {links.map((link, index) => (
        <tr key={link.id || `${link.segmentCode}-${startIndex + index}`}>
          <td>{startIndex + index + 1}</td>
          <td className="break-cell min-w-[240px]">{link.serviceId ?? "-"}</td>
          <td>{readableSegmentName(link)}</td>
          <td>
            <span className={roleBadgeClass(link.topologyRole)} title={topologyRoleSourceLabel(link.topologyRoleSource)}>
              {topologyRoleLabel(link.topologyRole)}
            </span>
          </td>
          <td>{link.localSite ?? "-"}</td>
          <td>{rack(link, "near")}</td>
          <td>{odf(link, "near")}</td>
          <td>{port(link, "near")}</td>
          <td>{link.farSite ?? "-"}</td>
          <td>{rack(link, "far")}</td>
          <td>{odf(link, "far")}</td>
          <td>{port(link, "far")}</td>
        </tr>
      ))}
    </>
  );
}

// memo: the detail table only depends on `trace`, which is stable while the
// operator types into the search/allocation form — so it skips re-rendering on
// every keystroke (a major source of Trace Route page lag).
export const TraceDetailsTable = memo(function TraceDetailsTable({ trace }: { trace: ServiceTraceResult }) {
  const serviceLinks = trace.serviceLinks ?? [];
  const summaries = segmentSummary(serviceLinks);

  // Group every link by its effective topology role so the operator can see, in
  // one table, which rows are main ring vs subring vs spur vs review.
  const grouped = new Map<string, ServiceTraceLinkView[]>();
  for (const link of serviceLinks) {
    const role = String(link.topologyRole ?? "MAIN_RING").toUpperCase();
    grouped.set(role, [...(grouped.get(role) ?? []), link]);
  }
  const ROLE_ORDER = ["MAIN_RING", "SINGLE_HOMED", "SUBRING", "SPUR", "SPUR_CHAIN", "INTERCONNECT", "REVIEW"];
  const rank = (role: string) => {
    const index = ROLE_ORDER.indexOf(role);
    return index < 0 ? ROLE_ORDER.length : index;
  };
  const orderedRoles = [...grouped.keys()].sort((a, b) => rank(a) - rank(b));

  let runningIndex = 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-3">
        {summaries.length ? summaries.map((summary) => (
          <div key={summary.segment} className="rounded-2xl border border-border bg-white/5 p-4">
            <div className="text-xs uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300">Segment summary</div>
            <div className="mt-1 font-semibold text-slate-950 dark:text-white">{summary.segment}</div>
            <div className="mt-2 flex gap-2 text-sm">
              <span className="badge bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200">Available {summary.available}</span>
              <span className="badge bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-200">Active {summary.used}</span>
            </div>
          </div>
        )) : (
          <div className="rounded-2xl border border-border bg-white/5 p-4 text-sm text-slate-600 dark:text-slate-300">No segment-level child links were returned for this trace.</div>
        )}
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="section-title">Service trail table</div>
          <div className="flex flex-wrap gap-2">
            {orderedRoles.map((role) => (
              <span key={role} className={roleBadgeClass(role)}>{topologyRoleLabel(role)} · {grouped.get(role)?.length ?? 0}</span>
            ))}
          </div>
        </div>
        <div className="subtle mt-1">Rows are grouped by topology role. Only the specific child ODF port allocated to this service is shown; segment-wide capacity is intentionally excluded from this table.</div>
        {serviceLinks.length ? (
          <div className="trace-service-table-shell mt-4">
            <table className="trace-service-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Service ID</th>
                  <th>Segment</th>
                  <th>Topology Role</th>
                  <th>Near Site</th>
                  <th>Near Rack ID</th>
                  <th>Near End ODF ID</th>
                  <th>Near End ODF Ports</th>
                  <th>Far Site</th>
                  <th>Far Rack ID</th>
                  <th>Far ODF ID</th>
                  <th>Far ODF Ports</th>
                </tr>
              </thead>
              <tbody>
                {orderedRoles.map((role) => {
                  const links = grouped.get(role) ?? [];
                  const startIndex = runningIndex;
                  runningIndex += links.length;
                  return (
                    <Fragment key={`group-${role}`}>
                      <tr className="topology-group-divider-row">
                        <td colSpan={12}>
                          <span className={roleBadgeClass(role)}>{topologyRoleLabel(role)}</span>
                          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">{links.length} row(s)</span>
                        </td>
                      </tr>
                      <ServiceLinkRows links={links} startIndex={startIndex} />
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
            No specific child ODF port allocation rows were returned for this trace.
          </div>
        )}
      </div>
    </div>
  );
});
