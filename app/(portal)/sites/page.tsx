import { SiteDirectory } from "@/components/sites/site-directory";
import { hasPermission } from "@/lib/auth/permissions";
import { getSessionUser } from "@/lib/auth/session";
import { attachmentService } from "@/server/services/attachment.service";
import { siteRepository } from "@/server/repositories/site.repository";

export default async function SitesPage({ searchParams }: { searchParams?: Promise<{ search?: string; regionPrefix?: string }> }) {
  const params = await searchParams;
  const search = params?.search?.trim() ?? "";
  const regionPrefix = params?.regionPrefix?.trim() ?? "";
  const user = await getSessionUser();
  const [sites, siteDocStatuses] = await Promise.all([
    siteRepository.listSummary(),
    attachmentService.siteDocumentStatus(),
  ]);
  const docStatusBySiteId = new Map(siteDocStatuses.map((status) => [status.siteId, status.docStatus]));
  const documentsBySiteId = new Map(siteDocStatuses.map((status) => [status.siteId, status.documents]));
  return (
    <SiteDirectory
      initialSearch={search}
      initialRegionPrefix={regionPrefix}
      canDelete={hasPermission(user?.roleCode, "childLinkDelete")}
      canBulkDelete={hasPermission(user?.roleCode, "bulkDelete")}
      canUpload={hasPermission(user?.roleCode, "inventoryWrite")}
      initialSites={sites.map((site) => ({
        id: site.id,
        code: site.code,
        name: site.name,
        region: site.region,
        city: site.city,
        siteType: site.siteType,
        label: site.label,
        siteStructure: site.siteStructure,
        colocationType: site.colocationType,
        colocationOwner: site.colocationOwner,
        coordinateX: site.coordinateX,
        coordinateY: site.coordinateY,
        criticalityTags: site.criticalityTags.map((assignment) => ({ tag: { label: assignment.tag.label } })),
        docStatus: docStatusBySiteId.get(site.id) ?? { FDD: false, ODF_PHOTO: false, OTDR_REPORT: false },
        documents: documentsBySiteId.get(site.id) ?? { FDD: null, ODF_PHOTO: null, OTDR_REPORT: null },
        status: site.status,
        _count: site._count,
      }))}
    />
  );
}
