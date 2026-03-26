import { guessMimeFromFilename } from "@/lib/mime";
import { getLocalArtifactPath } from "@/lib/server/storage";
import { readFile, stat } from "fs/promises";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function parseRangeHeader(rangeHeader: string | null, size: number) {
  if (!rangeHeader?.startsWith("bytes=")) return null;
  const [startRaw, endRaw] = rangeHeader.replace("bytes=", "").split("-");
  const start = Number(startRaw);
  const end = endRaw ? Number(endRaw) : size - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || end >= size) return null;

  return { start, end };
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ storageKey: string[] }> },
) {
  const { storageKey } = await context.params;
  const key = storageKey.join("/");
  const filePath = getLocalArtifactPath(key);

  try {
    const fileStats = await stat(filePath);
    const file = await readFile(filePath);
    const contentType = guessMimeFromFilename(filePath);
    const range = parseRangeHeader(req.headers.get("range"), fileStats.size);

    if (range) {
      const chunk = file.subarray(range.start, range.end + 1);
      return new NextResponse(chunk, {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunk.byteLength),
          "Content-Range": `bytes ${range.start}-${range.end}/${fileStats.size}`,
          "Cache-Control": "no-store",
        },
      });
    }

    return new NextResponse(file, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileStats.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }
}
