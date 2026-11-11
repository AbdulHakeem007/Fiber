import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { attachmentService } from "@/server/services/attachment.service";
import { storedFileStream } from "@/lib/attachments/storage";

// GET /api/attachments/:id/download[?preview=1]
// Streams the file straight from disk to the response — the whole binary is never
// loaded into a server-side memory array. Returns 404 when the metadata row points
// at a file that is missing from the physical disk layer.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionUser();
    if (!hasPermission(session?.roleCode, "inventoryRead")) {
      return NextResponse.json({ error: "A valid portal session is required to download attachments." }, { status: 403 });
    }
    const { id } = await params;
    const target = await attachmentService.getDownloadTarget(id);
    if (!target) {
      return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
    }
    if (target.missing) {
      return NextResponse.json({ error: "The stored file is missing from disk. Run an attachment resync." }, { status: 404 });
    }

    const preview = new URL(request.url).searchParams.get("preview") === "1";
    const disposition = preview ? "inline" : "attachment";
    const encodedName = encodeURIComponent(target.row.originalFilename);
    const nodeStream = storedFileStream(target.absolutePath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

    return new Response(webStream, {
      headers: {
        "Content-Type": target.row.mimeType || "application/octet-stream",
        "Content-Length": String(target.size),
        "Content-Disposition": `${disposition}; filename="${target.row.originalFilename.replace(/[^\x20-\x7E]/g, "_")}"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Attachment download failed." },
      { status: 400 },
    );
  }
}
