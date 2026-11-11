import { notFound } from "next/navigation";
import { SiteConnectivityTable } from "@/components/sites/site-connectivity-table";
import { SiteActions } from "@/components/sites/site-actions";
import { SiteTopologyPanel } from "@/components/sites/site-topology-panel";
import { SiteInventoryDrilldown } from "@/components/sites/site-inventory-drilldown";
import { siteConnectivityService } from "@/server/services/site-connectivity.service";
import { siteRepository } from "@/server/repositories/site.repository";
import { splitterService } from "@/server/services/splitter.service";
import { prisma } from "@/lib/db/prisma";
import { getSiteFlags } from "@/lib/telecom/site-flags-db";

export default async function SiteDetailPage({ params }: { params: Promise<{ siteCode: string }> }) {
  const { siteCode } = await params;
  const site = await siteRepository.getByCode(siteCode);
  if (!site) notFound();
  const connectivity = await siteConnectivityService.getForSite(site.code);
  if (!connectivity) notFound();
  const localSplitters = await splitterService.listSplitters({ site: site.code });
  const siteFlags = (await getSiteFlags(prisma, [site.code])).get(site.code) ?? { isCriticalSite: false, isDatacenter: false };

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-2xl font-semibold">Site detail: {site.code}</div>
            <div className="subtle mt-1">{site.siteType ?? "Unknown type"} - {site.region ?? "Region TBD"} - {site.status}</div>
            <div className="mt-3 flex flex-wrap gap-2 text-sm">
              {site.criticalityTags.length ? <span className="badge border-red-300 bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-100">Criticality: {site.criticalityTags.map((item) => item.tag.label).join(", ")}</span> : null}
              {site.siteStructure ? <span className="badge border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">Structure: {site.siteStructure}</span> : null}
              {site.colocationType || site.colocationOwner ? <span className="badge border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">Colocation: {[site.colocationType, site.colocationOwner].filter(Boolean).join(" / ")}</span> : null}
              {site.coordinateX !== null && site.coordinateX !== undefined && site.coordinateY !== null && site.coordinateY !== undefined ? (
                <span className="badge border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">Coordinates: {site.coordinateX}, {site.coordinateY}</span>
              ) : null}
            </div>
            {site.isCoreSite ? <div className="mt-3 badge border-red-400/40 bg-red-500/10 text-red-100">{site.coreSiteType ?? "Core Site"}</div> : null}
          </div>
          <div className="flex flex-col items-end gap-3">
            <div className="badge badge-active">Direct connected sites: {connectivity.directConnectedSiteCount}</div>
            <div className="badge tag-none">Direct segments: {connectivity.directPhysicalSegmentCount}</div>
            <SiteActions
              site={{
                code: site.code,
                name: site.name,
                region: site.region,
                city: site.city,
                siteType: site.siteType,
                label: site.label,
                siteStructure: site.siteStructure,
                coordinateX: site.coordinateX,
                coordinateY: site.coordinateY,
                isCoreSite: site.isCoreSite,
                isCriticalSite: siteFlags.isCriticalSite,
                isDatacenter: siteFlags.isDatacenter,
                coreSiteType: site.coreSiteType,
                status: site.status,
                remarks: site.remarks,
              }}
            />
          </div>
        </div>
      </div>

      <SiteInventoryDrilldown siteCode={site.code} racks={site.racks} splitters={localSplitters} />
      <SiteTopologyPanel centerSite={site.code} nodes={connectivity.nodes} />
      <SiteConnectivityTable centerSite={site.code} rows={connectivity.rows} />
    </div>
  );
}
