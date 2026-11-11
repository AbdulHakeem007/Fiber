import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { emailExportService } from "@/server/services/email-export.service";

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "exportData")) {
      return NextResponse.json({ error: "A valid portal session is required to email exports." }, { status: 403 });
    }

    const body = await request.json();
    const result = await emailExportService.emailExport({
      type: body.type,
      siteCode: body.siteCode,
      serviceCode: body.serviceCode,
      batchId: body.batchId,
      search: typeof body.search === "string" ? body.search : null,
      connectedSite: typeof body.connectedSite === "string" ? body.connectedSite : null,
      serviceId: typeof body.serviceId === "string" ? body.serviceId : null,
      rackId: typeof body.rackId === "string" ? body.rackId : null,
      odfId: typeof body.odfId === "string" ? body.odfId : null,
      portPair: typeof body.portPair === "string" ? body.portPair : null,
      fiberPortNumber: typeof body.fiberPortNumber === "string" ? body.fiberPortNumber : null,
      cableId: typeof body.cableId === "string" ? body.cableId : null,
      tubeNumber: typeof body.tubeNumber === "string" ? body.tubeNumber : null,
      tubeColor: typeof body.tubeColor === "string" ? body.tubeColor : null,
      fiberNumber: typeof body.fiberNumber === "string" ? body.fiberNumber : null,
      status: typeof body.status === "string" ? body.status : null,
      siteType: typeof body.siteType === "string" ? body.siteType : null,
      regionPrefix: typeof body.regionPrefix === "string" ? body.regionPrefix : null,
      dateFrom: typeof body.dateFrom === "string" ? body.dateFrom : null,
      dateTo: typeof body.dateTo === "string" ? body.dateTo : null,
      tag: typeof body.tag === "string" ? body.tag : null,
      recipients: body.recipients,
      includeConfiguredRecipients: Boolean(body.includeConfiguredRecipients),
      message: typeof body.message === "string" ? body.message : null,
      subject: typeof body.subject === "string" ? body.subject : null,
      body: typeof body.body === "string" ? body.body : null,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Email export failed." },
      { status: 400 },
    );
  }
}
