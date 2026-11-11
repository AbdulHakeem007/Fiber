// Runtime-managed, admin-editable topology alert definitions.
//
// Stores the plain-language definitions for the Topology alert rule (single-homed
// rings, spurs, spur chains, inactive links) that the administrator can rewrite so
// recipients understand exactly what was detected. Backed by the schema-managed
// `AlertDefinition` model (previously a runtime CREATE TABLE).

import { prisma } from "@/lib/db/prisma";

export type TopologyDefinitionKey = "SINGLE_HOMED" | "SPUR" | "SPUR_CHAIN" | "INACTIVE_LINK";

export interface TopologyDefinition {
  key: TopologyDefinitionKey;
  label: string;
  definition: string;
}

/** Seed text shown until an admin overrides it. Also fixes the canonical key set. */
const DEFAULTS: TopologyDefinition[] = [
  {
    key: "SINGLE_HOMED",
    label: "Single-homed rings",
    definition: "A ring or site reachable through only one physical path/neighbour, so a single cable or node failure isolates it. No protecting alternate route exists.",
  },
  {
    key: "SPUR",
    label: "Spur",
    definition: "A dead-end branch hanging off the backbone with no alternate return path to the ring. Everything beyond the spur depends on that one segment.",
  },
  {
    key: "SPUR_CHAIN",
    label: "Spur chain",
    definition: "Two or more spurs connected in series, compounding the single-path dependency — a failure near the root drops every downstream site on the chain.",
  },
  {
    key: "INACTIVE_LINK",
    label: "Inactive links",
    definition: "Links that are decommissioned, planned, or otherwise not carrying live traffic but still referenced in inventory, which can distort topology and capacity views.",
  },
];

const VALID_KEYS = new Set(DEFAULTS.map((definition) => definition.key));

/** All four definitions, with any admin overrides merged over the seed text. */
export async function getTopologyDefinitions(): Promise<TopologyDefinition[]> {
  const rows = await prisma.alertDefinition.findMany({ select: { key: true, label: true, definition: true } });
  const stored = new Map(rows.map((row) => [row.key, row]));
  return DEFAULTS.map((fallback) => {
    const override = stored.get(fallback.key);
    return override ? { key: fallback.key, label: override.label, definition: override.definition } : fallback;
  });
}

export async function upsertTopologyDefinition(key: string, label: string, definition: string): Promise<TopologyDefinition> {
  const normalizedKey = String(key).trim().toUpperCase() as TopologyDefinitionKey;
  if (!VALID_KEYS.has(normalizedKey)) throw new Error("Unknown topology definition key.");
  const safeLabel = String(label ?? "").trim() || normalizedKey;
  const safeDefinition = String(definition ?? "").trim();
  await prisma.alertDefinition.upsert({
    where: { key: normalizedKey },
    update: { label: safeLabel, definition: safeDefinition },
    create: { key: normalizedKey, label: safeLabel, definition: safeDefinition },
  });
  return { key: normalizedKey, label: safeLabel, definition: safeDefinition };
}
