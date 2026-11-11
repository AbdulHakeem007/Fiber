import { NextResponse } from "next/server";
import { suggestionService } from "@/server/services/suggestion.service";

export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");

  try {
    switch (kind) {
      case "sites":
        return NextResponse.json({ suggestions: await suggestionService.sites(q) });
      case "services":
        return NextResponse.json({ suggestions: await suggestionService.services(q) });
      case "segments":
        return NextResponse.json({ suggestions: await suggestionService.segments(q) });
      case "racks":
        return NextResponse.json({ suggestions: await suggestionService.racks(searchParams.get("site"), q) });
      case "odfs":
        return NextResponse.json({ suggestions: await suggestionService.odfs(searchParams.get("site"), searchParams.get("rack"), q) });
      case "ports":
        return NextResponse.json({ suggestions: await suggestionService.ports(searchParams.get("site"), searchParams.get("rack"), searchParams.get("odf"), q) });
      case "connected-sites":
        return NextResponse.json({ suggestions: await suggestionService.connectedSites(searchParams.get("site"), q) });
      case "splitters":
        return NextResponse.json({ suggestions: await suggestionService.splitters(q) });
      case "transport-trails":
        return NextResponse.json({ suggestions: await suggestionService.transportTrail(q) });
      default:
        return NextResponse.json({ error: "Unknown suggestion type." }, { status: 404 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Suggestions failed." },
      { status: 400 },
    );
  }
}
