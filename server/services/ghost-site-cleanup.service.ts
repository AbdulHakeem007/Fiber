/**
 * Ghost Site Cleanup Service
 *
 * Handles cleaning up invalid directional metadata from ODF files.
 * Ghost sites are records that start with "To ", "to ", "TO " followed by a space.
 * These are directions, not actual sites.
 */

import { prisma } from "@/lib/db/prisma";

const GHOST_SITE_PATTERN = /^to\s+/i;

function isGhostSite(name?: string | null, code?: string | null): boolean {
  const text = name || code || "";
  return GHOST_SITE_PATTERN.test(text);
}

export const ghostSiteCleanupService = {
  /**
   * Find all ghost sites in the database.
   * Used for inspection before cleanup.
   */
  async findGhostSites() {
    const sites = await prisma.site.findMany({
      where: {
        OR: [
          { name: { startsWith: "To " } },
          { name: { startsWith: "to " } },
          { name: { startsWith: "TO " } },
          { code: { startsWith: "To " } },
          { code: { startsWith: "to " } },
          { code: { startsWith: "TO " } },
        ],
      },
      select: { id: true, code: true, name: true, _count: { select: { racks: true, odfs: true } } },
      take: 1000,
    });
    return sites;
  },

  /**
   * Clean up ghost sites from the database.
   * Safely handles cascading deletes or skipping sites with relations.
   */
  async cleanupGhostSites() {
    const ghostSites = await this.findGhostSites();
    if (!ghostSites.length) return { cleaned: 0, errors: [], skipped: 0, totalFound: 0 };

    const errors: string[] = [];
    let cleaned = 0;
    let skipped = 0;

    for (const site of ghostSites) {
      try {
        // Check if site has any racks or ODF associations
        if (site._count.racks > 0 || site._count.odfs > 0) {
          // Skip this site - it has relations we shouldn't touch
          skipped += 1;
          continue;
        }

        // Delete the ghost site (no relations, safe to delete)
        await prisma.site.delete({ where: { id: site.id } });
        cleaned += 1;
      } catch (error) {
        errors.push(
          `Failed to delete ghost site ${site.code || site.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { cleaned, errors, skipped, totalFound: ghostSites.length };
  },

  /**
   * Validate a site name before creation/import.
   * Returns true if the site is valid (not a ghost).
   */
  validateSiteName(name: string | null, code: string | null): boolean {
    return !isGhostSite(name, code);
  },

  /**
   * Filter ghost sites from query results.
   * Use this in UI queries to hide ghost sites even if cleanup hasn't run.
   */
  filterGhostSites<T extends { name?: string | null; code?: string | null }>(
    sites: T[],
  ): T[] {
    return sites.filter((site) => !isGhostSite(site.name, site.code));
  },
};
