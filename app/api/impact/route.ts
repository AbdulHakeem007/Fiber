import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { parseInventoryFilters } from "@/lib/filters/inventory-filters";
import { impactAnalysisService } from "@/server/services/impact-analysis.service";

export async function GET(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "impactAnalyze")) {
      return NextResponse.json({ error: "A valid portal session is required to run impact analysis." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const summary = await impactAnalysisService.analyze(parseInventoryFilters(searchParams));
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Impact analysis failed." },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "impactAnalyze")) {
      return NextResponse.json({ error: "A valid portal session is required to run impact analysis." }, { status: 403 });
    }

    const body = await request.json();
    const summary = await impactAnalysisService.analyze(body.filters ?? body);
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Impact analysis failed." },
      { status: 400 },
    );
  }
}
