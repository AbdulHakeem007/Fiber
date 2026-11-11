import { NextResponse } from "next/server";
import { serviceTraceService } from "@/server/services/service-trace.service";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const service = searchParams.get("service")?.trim();
  const path = searchParams.get("path")?.trim();
  const detailed = searchParams.get("detailed") === "1";
  const nearSite = searchParams.get("nearSite")?.trim();
  const farSite = searchParams.get("farSite")?.trim();

  if (detailed) {
    if (!nearSite || !farSite) return NextResponse.json({ error: "Detailed Trace requires Near End Site and Far End Site." }, { status: 400 });
    const pathPreview = await serviceTraceService.previewDetailedTrace({
      nearSite,
      farSite,
      nearRack: searchParams.get("nearRack"),
      nearOdf: searchParams.get("nearOdf"),
      farRack: searchParams.get("farRack"),
      farOdf: searchParams.get("farOdf"),
    });
    return NextResponse.json({ trace: null, pathPreview });
  }

  if (!service && !path) {
    return NextResponse.json({ error: "Enter a service ID, transport trail/path, or both." }, { status: 400 });
  }

  const [trace, pathPreview] = await Promise.all([
    service ? serviceTraceService.getTrace(service) : Promise.resolve(null),
    path ? serviceTraceService.previewTransportPath(path) : Promise.resolve(null),
  ]);
  return NextResponse.json({ trace, pathPreview });
}
