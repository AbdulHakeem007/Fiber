import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { prisma } from "@/lib/db/prisma";
import { normalizeOdfCode } from "@/lib/validation/odf";
import { normalizePortLabel, normalizeRackCode } from "@/lib/telecom/connection-identity";
import { splitterService } from "@/server/services/splitter.service";

const SPLITTER_SCOPES = new Set(["OSP", "ISP"]);
const SPLITTER_TYPES = new Set(["OSP_SPL", "ISP_SPL"]);
const PROTECTION_MODES = new Set(["PROTECTED", "UNPROTECTED", "NON_PROTECTED", "UNKNOWN"]);
const RESOURCE_STATUSES = new Set(["ACTIVE", "AVAILABLE", "RESERVED", "MAINTENANCE", "INACTIVE", "FAULTY", "DUMMY", "PLANNED", "DECOMMISSIONED"]);

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanUpper(value: unknown): string | null {
  return clean(value)?.toUpperCase() ?? null;
}

function protectionModeFromPayload(payload: Record<string, unknown>): string {
  const requested = cleanUpper(payload.protectionMode);
  if (requested) {
    if (!PROTECTION_MODES.has(requested)) throw new Error("Protection mode must be Protected, Non Protected, or Unknown.");
    return requested === "NON_PROTECTED" ? "UNPROTECTED" : requested;
  }
  const sourcePath = [
    payload.primaryInputSiteCode,
    payload.secondaryInputSiteCode,
    payload.location,
    payload.locationContext,
    payload.splitterName,
    payload.remarks,
  ]
    .map((value) => clean(value))
    .filter(Boolean)
    .join(" ");
  return sourcePath.includes("&") ? "PROTECTED" : "UNKNOWN";
}


function buildManualSplitterInfo(payload: Record<string, unknown>, scope: string): { splitterName: string | null; location: string | null } {
  const exchange = cleanUpper(payload.primaryInputSiteCode);
  const customerOrLocation = clean(payload.location) ?? clean(payload.splitterName);
  const farEnd = cleanUpper(payload.secondaryInputSiteCode) ?? clean(payload.destinationSiteCode) ?? customerOrLocation;
  const hh = clean(payload.handhole);
  const joint = clean(payload.jointNumber) ?? clean(payload.joint) ?? clean(payload.cabinet);
  const locationParts = [hh ? `HH ${hh}` : null, joint ? `Joint ${joint}` : null].filter(Boolean);
  if (scope === "ISP") return { splitterName: [exchange, customerOrLocation].filter(Boolean).join(" - ") || null, location: customerOrLocation };
  return { splitterName: [exchange, farEnd].filter(Boolean).join(" - ") || null, location: locationParts.length ? locationParts.join(" / ") : customerOrLocation };
}

function optionalInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function splitterPayload(payload: Record<string, unknown>) {
  const splitterCode = cleanUpper(payload.splitterCode);
  if (!splitterCode) throw new Error("Splitter ID is required.");
  const splitterType = cleanUpper(payload.splitterType) ?? (cleanUpper(payload.scope) === "ISP" ? "ISP_SPL" : "OSP_SPL");
  if (!SPLITTER_TYPES.has(splitterType)) throw new Error("Splitter Type must be OSP_SPL or ISP_SPL.");
  const scope = splitterType === "ISP_SPL" ? "ISP" : "OSP";
  if (!SPLITTER_SCOPES.has(scope)) throw new Error("Splitter scope must be OSP or ISP.");
  const protectionMode = protectionModeFromPayload(payload);
  const status = cleanUpper(payload.status) ?? "ACTIVE";
  if (!RESOURCE_STATUSES.has(status)) throw new Error("Invalid splitter status.");

  const generated = buildManualSplitterInfo(payload, scope);

  return {
    splitterCode,
    splitterName: generated.splitterName ?? clean(payload.splitterName),
    splitterType,
    scope,
    location: generated.location ?? clean(payload.location),
    locationContext: clean(payload.locationContext) ?? generated.location ?? clean(payload.location),
    handhole: clean(payload.handhole),
    cabinet: clean(payload.cabinet),
    protectionMode,
    primaryInputSiteCode: cleanUpper(payload.primaryInputSiteCode),
    primaryInputRackCode: normalizeRackCode(clean(payload.primaryInputRackCode)),
    primaryInputOdfCode: normalizeOdfCode(clean(payload.primaryInputOdfCode)),
    primaryInputPortLabel: normalizePortLabel(clean(payload.primaryInputPortLabel)),
    secondaryInputSiteCode: cleanUpper(payload.secondaryInputSiteCode),
    secondaryInputRackCode: normalizeRackCode(clean(payload.secondaryInputRackCode)),
    secondaryInputOdfCode: normalizeOdfCode(clean(payload.secondaryInputOdfCode)),
    secondaryInputPortLabel: normalizePortLabel(clean(payload.secondaryInputPortLabel)),
    outputPortCapacity: optionalInt(payload.outputPortCapacity),
    configuredOutputPorts: optionalInt(payload.configuredOutputPorts) ?? 0,
    status,
    source: "MANUAL",
    remarks: clean(payload.remarks),
  };
}

export async function GET(request: Request) {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "inventoryRead")) {
    return NextResponse.json({ error: "Inventory read access is required to view splitter inventory." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const filters = {
    search: searchParams.get("search") ?? undefined,
    splitterType: searchParams.get("splitterType") ?? undefined,
    status: searchParams.get("status") ?? undefined,
  };
  const page = Math.max(1, Number(searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(1000, Math.max(25, Number(searchParams.get("pageSize") ?? 100) || 100));
  const [result, summary] = await Promise.all([
    splitterService.listSplittersPage(filters, { page, pageSize }),
    splitterService.getSummary(filters),
  ]);
  return NextResponse.json({ ...result, summary });
}

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Inventory write access is required to add splitters." }, { status: 403 });
    }

    const data = splitterPayload(await request.json());
    const splitter = await prisma.splitter.create({ data: data as any });
    await writeAuditLog({
      entityType: "Splitter",
      entityId: splitter.id,
      action: "CREATE",
      newValue: data,
      changedById: session?.id ?? null,
      reason: "Manual splitter creation",
    });

    return NextResponse.json({ row: splitter });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Splitter create failed.";
    const status = message.includes("Unique constraint") ? 409 : 400;
    return NextResponse.json({ error: status === 409 ? "A splitter with this ID already exists." : message }, { status });
  }
}
