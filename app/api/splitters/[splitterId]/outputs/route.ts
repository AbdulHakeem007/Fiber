import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/audit/audit-log";
import { prisma } from "@/lib/db/prisma";
import { normalizeOdfCode } from "@/lib/validation/odf";
import { normalizePortLabel, normalizeRackCode, normalizeServiceCodeExact } from "@/lib/telecom/connection-identity";
import { splitterService } from "@/server/services/splitter.service";

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

function outputPayload(payload: Record<string, unknown>) {
  const capacityFibers = positiveInt(payload.capacityFibers);
  const serviceCode = normalizeServiceCodeExact(clean(payload.serviceCode));
  const status = cleanUpper(payload.status) ?? (serviceCode ? "ACTIVE" : "AVAILABLE");
  if (!RESOURCE_STATUSES.has(status)) throw new Error("Invalid splitter output status.");
  return {
    outputLabel: clean(payload.outputLabel),
    outputPort: normalizePortLabel(clean(payload.outputPort)),
    localSiteCode: cleanUpper(payload.localSiteCode),
    localRackCode: normalizeRackCode(clean(payload.localRackCode)),
    localOdfCode: normalizeOdfCode(clean(payload.localOdfCode)),
    localPortLabel: normalizePortLabel(clean(payload.localPortLabel)),
    destinationSiteCode: cleanUpper(payload.destinationSiteCode),
    destinationLabel: clean(payload.destinationLabel),
    destinationRackCode: normalizeRackCode(clean(payload.destinationRackCode)),
    destinationOdfCode: normalizeOdfCode(clean(payload.destinationOdfCode)),
    destinationPortLabel: normalizePortLabel(clean(payload.destinationPortLabel)),
    serviceCode,
    sharingCustomerServiceId: normalizeServiceCodeExact(clean(payload.sharingCustomerServiceId ?? payload.sharingCustomerServiceCode)),
    sharingCustomerServiceCode: normalizeServiceCodeExact(clean(payload.sharingCustomerServiceId ?? payload.sharingCustomerServiceCode)),
    capacityFibers,
    usedFibers: serviceCode || status === "ACTIVE" ? capacityFibers : 0,
    availableFibers: serviceCode || status === "ACTIVE" ? 0 : capacityFibers,
    status,
    remarks: clean(payload.remarks),
  };
}

export async function GET(_request: Request, { params }: { params: Promise<{ splitterId: string }> }) {
  const session = await getSessionUser();
  if (!hasPermission(session?.roleCode, "inventoryRead")) {
    return NextResponse.json({ error: "Inventory read access is required to view splitter outputs." }, { status: 403 });
  }
  const { splitterId } = await params;
  const rows = await splitterService.listSplitterOutputs(splitterId);
  return NextResponse.json({ rows });
}

export async function POST(request: Request, { params }: { params: Promise<{ splitterId: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryWrite")) {
      return NextResponse.json({ error: "Inventory write access is required to add splitter outputs." }, { status: 403 });
    }

    const { splitterId } = await params;
    const splitter = await prisma.splitter.findUnique({ where: { id: splitterId }, select: { id: true } });
    if (!splitter) return NextResponse.json({ error: "Splitter not found." }, { status: 404 });

    const data = outputPayload(await request.json());
    const output = await prisma.splitterOutput.create({ data: { ...data, splitterId } as any });
    await writeAuditLog({
      entityType: "SplitterOutput",
      entityId: output.id,
      action: "CREATE",
      newValue: data,
      changedById: session?.id ?? null,
      reason: "Manual splitter output creation",
    });
    return NextResponse.json({ row: output });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Splitter output create failed." }, { status: 400 });
  }
}
