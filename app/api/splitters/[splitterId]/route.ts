import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { assertIndividualDeleteAllowed, DeletePolicyError } from "@/lib/auth/delete-policy";
import { prisma } from "@/lib/db/prisma";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { normalizeOdfCode } from "@/lib/validation/odf";
import { normalizePortLabel, normalizeRackCode } from "@/lib/telecom/connection-identity";

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

function updatePayload(payload: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  if ("splitterCode" in payload) {
    const splitterCode = cleanUpper(payload.splitterCode);
    if (!splitterCode) throw new Error("Splitter ID is required.");
    data.splitterCode = splitterCode;
  }
  if ("splitterName" in payload) data.splitterName = clean(payload.splitterName);
  if ("splitterType" in payload || "scope" in payload) {
    const splitterType = cleanUpper(payload.splitterType) ?? (cleanUpper(payload.scope) === "ISP" ? "ISP_SPL" : "OSP_SPL");
    if (!SPLITTER_TYPES.has(splitterType)) throw new Error("Splitter Type must be OSP_SPL or ISP_SPL.");
    data.splitterType = splitterType;
    data.scope = splitterType === "ISP_SPL" ? "ISP" : "OSP";
  }
  if ("location" in payload) data.location = clean(payload.location);
  if ("locationContext" in payload) data.locationContext = clean(payload.locationContext);
  if ("handhole" in payload) data.handhole = clean(payload.handhole);
  if ("cabinet" in payload) data.cabinet = clean(payload.cabinet);
  if ("protectionMode" in payload || "primaryInputSiteCode" in payload || "secondaryInputSiteCode" in payload || "location" in payload || "locationContext" in payload || "splitterName" in payload) {
    data.protectionMode = protectionModeFromPayload(payload);
  }
  if ("primaryInputSiteCode" in payload) data.primaryInputSiteCode = cleanUpper(payload.primaryInputSiteCode);
  if ("primaryInputRackCode" in payload) data.primaryInputRackCode = normalizeRackCode(clean(payload.primaryInputRackCode));
  if ("primaryInputOdfCode" in payload) data.primaryInputOdfCode = normalizeOdfCode(clean(payload.primaryInputOdfCode));
  if ("primaryInputPortLabel" in payload) data.primaryInputPortLabel = normalizePortLabel(clean(payload.primaryInputPortLabel));
  if ("secondaryInputSiteCode" in payload) data.secondaryInputSiteCode = cleanUpper(payload.secondaryInputSiteCode);
  if ("secondaryInputRackCode" in payload) data.secondaryInputRackCode = normalizeRackCode(clean(payload.secondaryInputRackCode));
  if ("secondaryInputOdfCode" in payload) data.secondaryInputOdfCode = normalizeOdfCode(clean(payload.secondaryInputOdfCode));
  if ("secondaryInputPortLabel" in payload) data.secondaryInputPortLabel = normalizePortLabel(clean(payload.secondaryInputPortLabel));
  if ("outputPortCapacity" in payload) data.outputPortCapacity = optionalInt(payload.outputPortCapacity);
  if ("configuredOutputPorts" in payload) data.configuredOutputPorts = optionalInt(payload.configuredOutputPorts) ?? 0;
  if ("status" in payload) {
    const status = cleanUpper(payload.status) ?? "ACTIVE";
    if (!RESOURCE_STATUSES.has(status)) throw new Error("Invalid splitter status.");
    data.status = status;
  }
  if ("remarks" in payload) data.remarks = clean(payload.remarks);

  // EDIT HERE: Manual splitter edits generate Splitter Info; CSV/JSON import bypasses this route.
  const nextScope = String(data.scope ?? payload.scope ?? "OSP");
  const generated = buildManualSplitterInfo(payload, nextScope);
  if (generated.splitterName) data.splitterName = generated.splitterName;
  if (generated.location) data.location = generated.location;
  return data;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ splitterId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Inventory write access is required to edit splitters." }, { status: 403 });
    }

    const { splitterId } = await params;
    const data = updatePayload(await request.json());
    const splitter = await prisma.splitter.update({ where: { id: splitterId }, data: data as any });
    await writeAuditLog({
      entityType: "Splitter",
      entityId: splitterId,
      action: "UPDATE",
      newValue: data,
      changedById: session?.id ?? null,
      reason: "Manual splitter update",
    });
    return NextResponse.json({ row: splitter });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Splitter update failed." }, { status: 400 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ splitterId: string }> }) {
  try {
    const session = await getSessionUser();

    const { splitterId } = await params;
    const splitter = await prisma.splitter.findUnique({
      where: { id: splitterId },
      include: { outputs: true },
    });
    if (!splitter) return NextResponse.json({ error: "Splitter not found." }, { status: 404 });

    // RBAC: ADMIN may delete any splitter directly; READ_WRITE may delete an
    // individual splitter only once it is Decommissioned.
    assertIndividualDeleteAllowed(session?.roleCode, splitter.status, "splitter");

    if (splitter.outputs.some((output) => output.status === "ACTIVE" || output.serviceCode)) {
      return NextResponse.json(
        { error: "This splitter has active outputs. Delete, release, or deactivate outputs first." },
        { status: 400 },
      );
    }

    if (splitter.outputs.length) {
      await prisma.$transaction(async (tx) => {
        await tx.splitterOutput.updateMany({ where: { splitterId }, data: { status: "DECOMMISSIONED" } });
        await tx.splitter.update({ where: { id: splitterId }, data: { status: "DECOMMISSIONED" } });
      });
      await writeAuditLog({
        entityType: "Splitter",
        entityId: splitterId,
        action: "DELETE",
        changedById: session?.id ?? null,
        reason: "Splitter deactivated because output history exists.",
      });
      return NextResponse.json({ deactivated: true, message: "Splitter output history exists, so the splitter was deactivated instead of deleted." });
    }

    await prisma.splitter.delete({ where: { id: splitterId } });
    await writeAuditLog({
      entityType: "Splitter",
      entityId: splitterId,
      action: "DELETE",
      changedById: session?.id ?? null,
      reason: "Splitter deleted",
    });
    return NextResponse.json({ deletedId: splitterId });
  } catch (error) {
    if (error instanceof DeletePolicyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Splitter delete failed. Check dependencies and try again." }, { status: 500 });
  }
}
