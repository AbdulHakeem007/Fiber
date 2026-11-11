import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";

// Bulk inserts go through createMany in fixed-size chunks. The previous
// implementation issued one INSERT statement per row inside a single array
// transaction, which collapses at enterprise densities (200k child rows).
const INSERT_CHUNK_SIZE = 1000;

function chunked<T>(items: T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += INSERT_CHUNK_SIZE) {
    chunks.push(items.slice(index, index + INSERT_CHUNK_SIZE));
  }
  return chunks;
}

export const importRepository = {
  createBatch: async (data: Parameters<typeof prisma.importBatch.create>[0]["data"]) => prisma.importBatch.create({ data }),

  createStagingRows: async (rows: Prisma.ImportStagingRowCreateManyInput[]) => {
    const created: Awaited<ReturnType<typeof prisma.importStagingRow.createManyAndReturn>> = [];
    // Chunks insert sequentially, so the returned rows keep input order and
    // callers can still zip staged rows back to their parsed source rows.
    for (const chunk of chunked(rows)) {
      created.push(...(await prisma.importStagingRow.createManyAndReturn({ data: chunk })));
    }
    return created;
  },

  createIssues: async (issues: Prisma.ImportIssueCreateManyInput[]) => {
    if (!issues.length) return;
    for (const chunk of chunked(issues)) {
      await prisma.importIssue.createMany({ data: chunk });
    }
  },

  updateBatchCounts: async (id: string, data: Parameters<typeof prisma.importBatch.update>[0]["data"]) =>
    prisma.importBatch.update({ where: { id }, data }),

  getAliasLookupSeed: async () => {
    const sites = await prisma.site.findMany({
      include: { aliases: true },
      orderBy: { code: "asc" },
    });

    return sites.map((site) => ({
      canonicalCode: site.code,
      aliases: [site.code, ...(site.aliases.map((alias) => alias.alias) ?? []), site.name ?? ""].filter(Boolean),
    }));
  },

  getBatchReview: async (id: string) =>
    prisma.importBatch.findUnique({
      where: { id },
      include: {
        stagingRows: {
          orderBy: { rowNumber: "asc" },
          include: {
            normalizedSiteA: { select: { id: true, code: true, name: true } },
            normalizedSiteB: { select: { id: true, code: true, name: true } },
          },
        },
        issues: { orderBy: [{ severity: "desc" }, { createdAt: "asc" }] },
      },
    }),

  /**
   * API-response variant of getBatchReview: staging rows are windowed so a
   * 200k-row batch never ships its entire raw/normalized JSON payload over
   * one HTTP response. Batch counters remain exact (they live on the batch).
   * Server-side validation/commit flows that must see every row keep using
   * getBatchReview or query staging rows directly.
   */
  getBatchReviewWindow: async (id: string, windowSize = 2000) =>
    prisma.importBatch.findUnique({
      where: { id },
      include: {
        stagingRows: {
          orderBy: { rowNumber: "asc" },
          take: windowSize,
          include: {
            normalizedSiteA: { select: { id: true, code: true, name: true } },
            normalizedSiteB: { select: { id: true, code: true, name: true } },
          },
        },
        issues: { orderBy: [{ severity: "desc" }, { createdAt: "asc" }] },
      },
    }),
};
