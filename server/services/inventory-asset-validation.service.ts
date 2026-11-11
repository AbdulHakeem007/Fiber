import { normalizeAlias } from "@/lib/import/alias-normalizer";
import { normalizeSiteCode } from "@/lib/telecom/connection-identity";
import { normalizeRackCode } from "@/lib/telecom/connection-identity";
import { normalizeOdfCode } from "@/lib/validation/odf";

export const INVENTORY_ASSET_REQUIRED_MESSAGE =
  "Please ensure Site ID, ODF ID, and RACK ID are fully registered in the Inventory before adding a segment.";

export interface InventoryEndpointInput {
  siteCode?: string | null;
  rackCode?: string | null;
  odfCode?: string | null;
}

export interface RegisteredEndpointAssets {
  siteId: string;
  rackId: string;
  odfId: string;
  siteCode: string;
  rackCode: string;
  odfCode: string;
}

// Loose identity key: uppercase alphanumerics only. Stored inventory codes and
// operator-typed codes routinely disagree on hyphens, underscores, whitespace
// and casing ("R-01" vs "R01", "MOCK-ATN109" vs "MOCKATN109"); every
// cross-reference below compares on this key so those variants can never
// produce a false "not registered" negative.
function looseKey(value?: string | null): string | null {
  const text = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return text || null;
}

// All identity forms an ODF code may be stored or typed under. Canonical
// normalization (normalizeOdfCode) collapses to at most two letters and yields
// null for numeric identifiers like "ODF-1"/"01"; those must still resolve, so
// the raw loose key and its "ODF"-prefix-stripped variant are matched too.
function odfCandidateKeys(raw?: string | null): Set<string> {
  const keys = new Set<string>();
  const canonical = normalizeOdfCode(raw);
  if (canonical) keys.add(canonical);
  const loose = looseKey(raw);
  if (loose) {
    keys.add(loose);
    const withoutPrefix = loose.replace(/^ODF/, "");
    if (withoutPrefix) keys.add(withoutPrefix);
  }
  return keys;
}

function keysIntersect(a: Set<string>, b: Set<string>): boolean {
  for (const key of a) if (b.has(key)) return true;
  return false;
}

async function resolveSite(tx: any, rawSiteCode: string): Promise<{ id: string; code: string } | null> {
  const normalized = normalizeSiteCode(rawSiteCode) ?? normalizeAlias(rawSiteCode);
  const trimmed = rawSiteCode.trim();

  // Fast path: exact matches on code, display name (raw and normalized forms),
  // and the normalized alias table.
  const exact = await tx.site.findFirst({
    where: {
      OR: [
        ...(normalized ? [{ code: normalized }] : []),
        { code: trimmed.toUpperCase() },
        { name: trimmed },
        ...(normalized ? [{ name: normalized }] : []),
        ...(normalized ? [{ aliases: { some: { aliasNormalized: normalized } } }] : []),
        { aliases: { some: { aliasNormalized: trimmed.toUpperCase() } } },
      ],
    },
    select: { id: true, code: true },
  });
  if (exact) return exact;

  // Lenient path: sites (and aliases) may be stored with hyphen/underscore
  // separators that exact equality can never match against a stripped input.
  // Compare loose keys in memory; this only runs on manual mutation flows when
  // the fast path missed, so the bounded scan is acceptable.
  const wanted = looseKey(rawSiteCode);
  if (!wanted) return null;

  const sites: Array<{ id: string; code: string; name: string | null }> = await tx.site.findMany({
    select: { id: true, code: true, name: true },
  });
  const byCode = sites.find((site) => looseKey(site.code) === wanted || looseKey(site.name) === wanted);
  if (byCode) return { id: byCode.id, code: byCode.code };

  const aliases: Array<{ aliasNormalized: string; site: { id: string; code: string } }> = await tx.siteAlias.findMany({
    select: { aliasNormalized: true, site: { select: { id: true, code: true } } },
  });
  const byAlias = aliases.find((alias) => looseKey(alias.aliasNormalized) === wanted);
  return byAlias ? byAlias.site : null;
}

async function resolveRack(tx: any, siteId: string, rawRackCode: string): Promise<{ id: string; rackCode: string } | null> {
  const normalized = normalizeRackCode(rawRackCode);
  if (normalized) {
    const exact = await tx.rack.findUnique({
      where: { siteId_rackCode: { siteId, rackCode: normalized } },
      select: { id: true, rackCode: true },
    });
    if (exact) return exact;
  }

  const wanted = looseKey(rawRackCode);
  if (!wanted) return null;
  const racks: Array<{ id: string; rackCode: string }> = await tx.rack.findMany({
    where: { siteId },
    select: { id: true, rackCode: true },
  });
  return racks.find((rack) => looseKey(rack.rackCode) === wanted) ?? null;
}

async function resolveOdf(
  tx: any,
  siteId: string,
  rackId: string,
  rawOdfCode: string,
): Promise<{ id: string; odfCode: string } | null> {
  const canonical = normalizeOdfCode(rawOdfCode);
  if (canonical) {
    const exact = await tx.oDF.findUnique({
      where: { siteId_rackId_odfCode: { siteId, rackId, odfCode: canonical } },
      select: { id: true, odfCode: true },
    });
    if (exact) return exact;
  }

  const wanted = odfCandidateKeys(rawOdfCode);
  if (!wanted.size) return null;
  const odfs: Array<{ id: string; odfCode: string }> = await tx.oDF.findMany({
    where: { siteId, rackId },
    select: { id: true, odfCode: true },
  });
  return odfs.find((odf) => keysIntersect(odfCandidateKeys(odf.odfCode), wanted)) ?? null;
}

export async function resolveRegisteredEndpointAssets(tx: any, input: InventoryEndpointInput): Promise<RegisteredEndpointAssets> {
  // Presence check on the raw text, not on canonical normalization: numeric ODF
  // identifiers (e.g. "ODF-1") normalize to null but are still a provided value
  // and must be looked up, not rejected as missing.
  const rawSiteCode = String(input.siteCode ?? "").trim();
  const rawRackCode = String(input.rackCode ?? "").trim();
  const rawOdfCode = String(input.odfCode ?? "").trim();
  if (!rawSiteCode || !rawRackCode || !rawOdfCode) {
    throw new Error(INVENTORY_ASSET_REQUIRED_MESSAGE);
  }

  const site = await resolveSite(tx, rawSiteCode);
  if (!site) throw new Error(INVENTORY_ASSET_REQUIRED_MESSAGE);

  const rack = await resolveRack(tx, site.id, rawRackCode);
  if (!rack) throw new Error(INVENTORY_ASSET_REQUIRED_MESSAGE);

  const odf = await resolveOdf(tx, site.id, rack.id, rawOdfCode);
  if (!odf) throw new Error(INVENTORY_ASSET_REQUIRED_MESSAGE);

  return {
    siteId: site.id,
    rackId: rack.id,
    odfId: odf.id,
    siteCode: site.code,
    rackCode: rack.rackCode,
    odfCode: odf.odfCode,
  };
}

export interface EndpointRegistrationStatus {
  site: boolean;
  rack: boolean;
  odf: boolean;
  siteCode: string | null;
  rackCode: string | null;
  odfCode: string | null;
}

/**
 * Read-only, non-throwing sibling of resolveRegisteredEndpointAssets used purely
 * to drive live "is this registered?" indicators in the UI. It reuses the exact
 * same lenient resolve helpers, so a green check here guarantees the segment
 * save will accept the value (and a red cross guarantees it would be rejected) —
 * they can never disagree. It does NOT alter the mutation-time validator. Each
 * level is only evaluated once its parent resolves (a rack is scoped to a site,
 * an ODF to a site+rack), which matches how the save path binds the assets.
 */
export async function checkEndpointRegistration(tx: any, input: InventoryEndpointInput): Promise<EndpointRegistrationStatus> {
  const status: EndpointRegistrationStatus = { site: false, rack: false, odf: false, siteCode: null, rackCode: null, odfCode: null };

  const rawSiteCode = String(input.siteCode ?? "").trim();
  const rawRackCode = String(input.rackCode ?? "").trim();
  const rawOdfCode = String(input.odfCode ?? "").trim();

  if (!rawSiteCode) return status;
  const site = await resolveSite(tx, rawSiteCode);
  if (!site) return status;
  status.site = true;
  status.siteCode = site.code;

  if (!rawRackCode) return status;
  const rack = await resolveRack(tx, site.id, rawRackCode);
  if (!rack) return status;
  status.rack = true;
  status.rackCode = rack.rackCode;

  if (!rawOdfCode) return status;
  const odf = await resolveOdf(tx, site.id, rack.id, rawOdfCode);
  if (!odf) return status;
  status.odf = true;
  status.odfCode = odf.odfCode;

  return status;
}
