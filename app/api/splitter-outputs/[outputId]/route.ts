import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { assertIndividualDeleteAllowed, DeletePolicyError } from "@/lib/auth/delete-policy";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { prisma } from "@/lib/db/prisma";
import { normalizeOdfCode } from "@/lib/validation/odf";
import { normalizePortLabel, normalizeRackCode, normalizeServiceCodeExact } from "@/lib/telecom/connection-identity";

const RESOURCE_STATUSES = new Set(["ACTIVE", "AVAILABLE", "RESERVED", "MAINTENANCE", "INACTIVE", "FAULTY", "DUMMY", "DECOMMISSIONED"]);

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanUpper(value: unknown): string | null {
  return clean(value)?.toUpperCase() ?? null;
}

function positiveInt(value: unknown, fallback = 1): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function outputPatch(payload: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  if ("outputLabel" in payload) data.outputLabel = clean(payload.outputLabel);
  if ("outputPort" in payload) data.outputPort = normalizePortLabel(clean(payload.outputPort));
  if ("localSiteCode" in payload) data.localSiteCode = cleanUpper(payload.localSiteCode);
  if ("localRackCode" in payload) data.localRackCode = normalizeRackCode(clean(payload.localRackCode));
  if ("localOdfCode" in payload) data.localOdfCode = normalizeOdfCode(clean(payload.localOdfCode));
  if ("localPortLabel" in payload) data.localPortLabel = normalizePortLabel(clean(payload.localPortLabel));
  if ("destinationSiteCode" in payload) data.destinationSiteCode = cleanUpper(payload.destinationSiteCode);
  if ("destinationLabel" in payload) data.destinationLabel = clean(payload.destinationLabel);
  if ("destinationRackCode" in payload) data.destinationRackCode = normalizeRackCode(clean(payload.destinationRackCode));
  if ("destinationOdfCode" in payload) data.destinationOdfCode = normalizeOdfCode(clean(payload.destinationOdfCode));
  if ("destinationPortLabel" in payload) data.destinationPortLabel = normalizePortLabel(clean(payload.destinationPortLabel));
  if ("serviceCode" in payload) data.serviceCode = normalizeServiceCodeExact(clean(payload.serviceCode));
  if ("sharingCustomerServiceCode" in payload || "sharingCustomerServiceId" in payload) {
    const sharingService = normalizeServiceCodeExact(clean(payload.sharingCustomerServiceId ?? payload.sharingCustomerServiceCode));
    data.sharingCustomerServiceId = sharingService;
    data.sharingCustomerServiceCode = sharingService;
  }
  if ("capacityFibers" in payload) data.capacityFibers = positiveInt(payload.capacityFibers);
  if ("status" in payload) {
    const status = cleanUpper(payload.status) ?? "AVAILABLE";
    if (!RESOURCE_STATUSES.has(status)) throw new Error("Invalid splitter output status.");
    data.status = status;
  }
  if ("remarks" in payload) data.remarks = clean(payload.remarks);

  const capacity = Number(data.capacityFibers);
  const status = String(data.status ?? "");
  const serviceCode = data.serviceCode === undefined ? undefined : data.serviceCode;
  if (Number.isInteger(capacity) || status || serviceCode !== undefined) {
    const effectiveCapacity = Number.isInteger(capacity) ? capacity : undefined;
    if (serviceCode || status === "ACTIVE") {
      if (effectiveCapacity !== undefined) {
        data.usedFibers = effectiveCapacity;
        data.availableFibers = 0;
      }
    } else if (status === "AVAILABLE" || serviceCode === null) {
      if (effectiveCapacity !== undefined) {
        data.usedFibers = 0;
        data.availableFibers = effectiveCapacity;
      }
    }
  }
  return data;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ outputId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Inventory write access is required to edit splitter outputs." }, { status: 403 });
    }

    const { outputId } = await params;
    const data = outputPatch(await request.json());
    const output = await prisma.splitterOutput.update({ where: { id: outputId }, data: data as any });
    await writeAuditLog({
      entityType: "SplitterOutput",
      entityId: outputId,
      action: "UPDATE",
      newValue: data,
      changedById: session?.id ?? null,
      reason: "Manual splitter output update",
    });
    return NextResponse.json({ row: output });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Splitter output update failed." }, { status: 400 });
  }
}

export async function PUT(request: Request, context: { params: Promise<{ outputId: string }> }) {
  return PATCH(request, context);
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ outputId: string }> }) {
  try {
    const session = await getSessionUser();

    const { outputId } = await params;
    const output = await prisma.splitterOutput.findUnique({ where: { id: outputId } });
    if (!output) return NextResponse.json({ error: "Splitter output not found." }, { status: 404 });

    // RBAC: ADMIN may delete any output directly; READ_WRITE may delete an
    // individual output only once it is Decommissioned.
    assertIndividualDeleteAllowed(session?.roleCode, output.status, "splitter output");

    if (output.serviceCode || output.status === "ACTIVE") {
      return NextResponse.json({ error: "This splitter output is active on a service. Release the service before deleting." }, { status: 400 });
    }

    await prisma.splitterOutput.delete({ where: { id: outputId } });
    await writeAuditLog({
      entityType: "SplitterOutput",
      entityId: outputId,
      action: "DELETE",
      changedById: session?.id ?? null,
      reason: "Manual splitter output delete",
    });
    return NextResponse.json({ deletedId: outputId, message: "Splitter output deleted successfully." });
  } catch (error) {
    if (error instanceof DeletePolicyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Splitter output delete failed. Check dependencies and try again." }, { status: 500 });
  }
}
