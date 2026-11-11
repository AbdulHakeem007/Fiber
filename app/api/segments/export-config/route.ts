import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { buildSegmentDeletionExport } from "@/server/services/segment-config-export.service";

/**
 * Excel export offered when segments are marked for deletion:
 *  - "Dependent Service Chains": one row per dependent Service ID with its
 *    sequential end-to-end transport chain (per-hop Rack/ODF omitted; only the
 *    source segment's Rack/ODF identity is included).
 *  - "Source Segment Config" + "Source Port Mappings": the deleted segment's
 *    own configuration for future reference or a manual rebuild.
 */
export async function GET(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "exportData")) {
      return NextResponse.json({ error: "A valid portal session is required to export data." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const ids = String(searchParams.get("ids") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (!ids.length) {
      return NextResponse.json({ error: "No segment ids supplied." }, { status: 400 });
    }

    const data = await buildSegmentDeletionExport(ids);
    const workbook = XLSX.utils.book_new();
    const appendSheet = (rows: Record<string, unknown>[], name: string, emptyMessage: string) => {
      const safeRows = rows.length ? rows : [{ message: emptyMessage }];
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(safeRows), name.slice(0, 31));
    };
    appendSheet(data.serviceChainRows, "Dependent Service Chains", "No live services depend on the selected segment(s).");
    appendSheet(data.segmentConfigRows, "Source Segment Config", "No segment configuration found.");
    appendSheet(data.portMappingRows, "Source Port Mappings", "No child port mappings on the selected segment(s).");
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="segment-deletion-impact-${data.fileStamp}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Segment deletion export failed." },
      { status: 500 },
    );
  }
}
