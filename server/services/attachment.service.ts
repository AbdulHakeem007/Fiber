import type { SegmentAttachment } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { SessionUser } from "@/lib/auth/guards";
import {
  buildAttachmentStorageTarget,
  deleteStoredFile,
  listStoredAttachmentFiles,
  storedFileStat,
  writeUploadedFile,
} from "@/lib/attachments/storage";

// documentType is a plain String column (per the SegmentAttachment model), not a
// Prisma enum, so the allowed values are validated here in the service layer.
export type AttachmentDocumentType =
  | "FDD"
  | "ODF_PHOTO"
  | "OTDR_REPORT"
  | "ATP"
  | "HANDOVER"
  | "SITE_PHOTO"
  | "OTHER";

const DOCUMENT_TYPES = new Set<AttachmentDocumentType>([
  "FDD",
  "ODF_PHOTO",
  "OTDR_REPORT",
  "ATP",
  "HANDOVER",
  "SITE_PHOTO",
  "OTHER",
]);

// SegmentAttachment is a Prisma model created by migrations; no runtime DDL is
// needed. Retained as a no-op so existing call sites stay valid.
async function ensureAttachmentTable() {}

type AttachmentScope = { siteId: string };
type ResolvedAttachmentScope = { type: "site"; input: string; siteId: string; displayId: string };

function clean(value: FormDataEntryValue | string | null | undefined) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

function parseScope(segmentId?: string | null, siteId?: string | null): AttachmentScope {
  const cleanSegmentId = clean(segmentId);
  const cleanSiteId = clean(siteId);
  if (cleanSegmentId) throw new Error("Segment-level attachments are deprecated. Upload documents from the Sites Database page.");
  if (!cleanSiteId) throw new Error("Site ID is required for document uploads.");
  return { siteId: cleanSiteId };
}

function parseDocumentType(value: FormDataEntryValue | string | null | undefined): AttachmentDocumentType {
  const documentType = clean(value)?.toUpperCase() as AttachmentDocumentType | undefined;
  if (!documentType || !DOCUMENT_TYPES.has(documentType)) {
    throw new Error("Invalid document type.");
  }
  return documentType;
}

function uploadedBy(session: SessionUser) {
  return session.name?.trim() || session.email?.trim() || session.id;
}

async function resolveScope(scope: AttachmentScope): Promise<ResolvedAttachmentScope> {
  const site = await prisma.site.findFirst({
    where: {
      OR: [
        { id: scope.siteId! },
        { code: scope.siteId! },
        { aliases: { some: { aliasNormalized: scope.siteId!.toUpperCase() } } },
      ],
    },
    select: { id: true, code: true },
  });
  if (!site) throw new Error("Site ID was not found.");
  return { type: "site", input: scope.siteId!, siteId: site.id, displayId: site.code };
}

function serializeAttachment(row: SegmentAttachment) {
  return {
    ...row,
    fileSizeBytes: Number(row.fileSizeBytes),
    uploadedAt: row.uploadedAt.toISOString(),
  };
}

// Document types whose presence is surfaced as the three status "lights" on the
// Attachment page / ODF mappings overview (issue #5). Keep in sync with the UI.
const STATUS_LIGHT_TYPES = ["FDD", "ODF_PHOTO", "OTDR_REPORT"] as const;
export type StatusLightType = (typeof STATUS_LIGHT_TYPES)[number];

export interface SiteSegmentDocStatus {
  siteId: string;
  siteCode: string;
  siteName: string | null;
  docStatus: Record<StatusLightType, boolean>;
  documents: Record<StatusLightType, ReturnType<typeof serializeAttachment> | null>;
}

export const attachmentService = {
  documentTypes: [...DOCUMENT_TYPES],
  statusLightTypes: [...STATUS_LIGHT_TYPES],

  /**
   * Resolve a Site ID / code / alias to the live fiber segments connected to it,
   * each annotated with whether its FDD / ODF photo / OTDR document is present.
   *
   * Drives both the Attachment-page segment autocomplete (issue #4 — type a site,
   * see every connected segment) and the documentation status overview (issue #5
   * — three green/red lights per segment). One query so the dropdown and the
   * status list never drift.
   */
  async siteDocumentStatus(siteIds?: string[]): Promise<SiteSegmentDocStatus[]> {
    await ensureAttachmentTable();
    const sites = await prisma.site.findMany({
      where: siteIds?.length ? { id: { in: siteIds } } : undefined,
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    });
    if (!sites.length) return [];

    const docRows = await prisma.segmentAttachment.findMany({
      where: { siteId: { in: sites.map((site) => site.id) }, documentType: { in: [...STATUS_LIGHT_TYPES] } },
      orderBy: { uploadedAt: "desc" },
    });
    const docsBySite = new Map<string, Set<string>>();
    const latestBySite = new Map<string, Partial<Record<StatusLightType, ReturnType<typeof serializeAttachment>>>>();
    for (const doc of docRows) {
      if (!doc.siteId) continue;
      const documentType = doc.documentType as StatusLightType;
      const set = docsBySite.get(doc.siteId) ?? new Set<string>();
      set.add(documentType);
      docsBySite.set(doc.siteId, set);
      const latest = latestBySite.get(doc.siteId) ?? {};
      if (!latest[documentType]) latest[documentType] = serializeAttachment(doc);
      latestBySite.set(doc.siteId, latest);
    }

    return sites.map((site) => {
      const present = docsBySite.get(site.id) ?? new Set<string>();
      const latest = latestBySite.get(site.id) ?? {};
      return {
        siteId: site.id,
        siteCode: site.code,
        siteName: site.name,
        docStatus: {
          FDD: present.has("FDD"),
          ODF_PHOTO: present.has("ODF_PHOTO"),
          OTDR_REPORT: present.has("OTDR_REPORT"),
        },
        documents: {
          FDD: latest.FDD ?? null,
          ODF_PHOTO: latest.ODF_PHOTO ?? null,
          OTDR_REPORT: latest.OTDR_REPORT ?? null,
        },
      };
    });
  },

  async siteSegmentsWithDocStatus(siteQuery: string | null | undefined): Promise<{
    scope: { siteId: string; code: string; name: string | null } | null;
    segments: SiteSegmentDocStatus[];
  }> {
    await ensureAttachmentTable();
    const query = clean(siteQuery);
    if (!query) return { scope: null, segments: [] };

    const site = await prisma.site.findFirst({
      where: {
        OR: [
          { id: query },
          { code: query.toUpperCase() },
          { name: query },
          { aliases: { some: { aliasNormalized: query.toUpperCase() } } },
        ],
      },
      select: { id: true, code: true, name: true },
    });
    if (!site) return { scope: null, segments: [] };

    const siteStatus = await this.siteDocumentStatus([site.id]);
    return { scope: { siteId: site.id, code: site.code, name: site.name }, segments: siteStatus };
  },

  async siteDocumentSummary() {
    const statuses = await this.siteDocumentStatus();
    const counts = { FDD: 0, ODF_PHOTO: 0, OTDR_REPORT: 0 };
    for (const status of statuses) {
      for (const type of STATUS_LIGHT_TYPES) {
        if (status.docStatus[type]) counts[type] += 1;
      }
    }
    return {
      totalSites: statuses.length,
      requiredDocuments: statuses.length * STATUS_LIGHT_TYPES.length,
      uploadedDocuments: counts.FDD + counts.ODF_PHOTO + counts.OTDR_REPORT,
      counts,
    };
  },
  async list(params: { segmentId?: string | null; siteId?: string | null }) {
    await ensureAttachmentTable();
    const scope = parseScope(params.segmentId, params.siteId);
    const resolvedScope = await resolveScope(scope);

    const rows = await prisma.segmentAttachment.findMany({
      where: { siteId: resolvedScope.siteId },
      orderBy: { uploadedAt: "desc" },
    });

    return {
      scope: resolvedScope,
      attachments: rows.map(serializeAttachment),
    };
  },

  async upload(formData: FormData, session: SessionUser) {
    await ensureAttachmentTable();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new Error("Missing file field.");
    }
    if (file.size <= 0) {
      throw new Error("Uploaded file is empty.");
    }

    const scope = parseScope(clean(formData.get("segmentId")), clean(formData.get("siteId")));
    const resolvedScope = await resolveScope(scope);
    const documentType = parseDocumentType(formData.get("documentType"));
    const remarks = clean(formData.get("remarks"));
    const target = buildAttachmentStorageTarget({
      segmentId: null,
      siteId: resolvedScope.siteId,
      documentType,
      originalFilename: file.name,
    });

    await writeUploadedFile(file, target.absolutePath);

    try {
      const row = await prisma.segmentAttachment.create({
        data: {
          segmentId: null,
          siteId: resolvedScope.siteId,
          documentType,
          originalFilename: file.name,
          storedFilename: target.storedFilename,
          storagePath: target.storagePath,
          mimeType: file.type || "application/octet-stream",
          fileSizeBytes: file.size,
          uploadedBy: uploadedBy(session),
          remarks,
        },
      });
      return serializeAttachment(row);
    } catch (error) {
      await deleteStoredFile(target.storagePath).catch(() => undefined);
      throw error;
    }
  },

  async getDownloadTarget(id: string) {
    await ensureAttachmentTable();
    const row = await prisma.segmentAttachment.findUnique({ where: { id } });
    if (!row) return null;

    try {
      const { absolutePath, info } = await storedFileStat(row.storagePath);
      if (!info.isFile()) return { row: serializeAttachment(row), missing: true as const };
      return {
        row: serializeAttachment(row),
        absolutePath,
        size: info.size,
        missing: false as const,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { row: serializeAttachment(row), missing: true as const };
      }
      throw error;
    }
  },

  async delete(id: string) {
    await ensureAttachmentTable();
    const row = await prisma.segmentAttachment.findUnique({ where: { id } });
    if (!row) return null;

    await prisma.segmentAttachment.delete({ where: { id } });
    const fileResult = await deleteStoredFile(row.storagePath);
    return { deletedId: id, ...fileResult };
  },

  async resyncReport() {
    await ensureAttachmentTable();
    const rows = await prisma.segmentAttachment.findMany({ orderBy: { uploadedAt: "desc" } });
    const storedPaths = new Set(rows.map((row) => row.storagePath.replace(/\\/g, "/")));
    const missingFiles = [];

    for (const row of rows) {
      try {
        const { info } = await storedFileStat(row.storagePath);
        if (!info.isFile()) missingFiles.push(serializeAttachment(row));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          missingFiles.push(serializeAttachment(row));
        } else {
          throw error;
        }
      }
    }

    const files = await listStoredAttachmentFiles();
    const orphanFiles = files.filter((storagePath) => !storedPaths.has(storagePath));

    return {
      checkedMetadataRows: rows.length,
      checkedStorageFiles: files.length,
      missingFiles,
      orphanFiles,
    };
  },
};
