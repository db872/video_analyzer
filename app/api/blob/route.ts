import { handleUpload } from "@vercel/blob/client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function maxBytes() {
  const raw = process.env.MAX_UPLOAD_BYTES;
  if (raw) {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 2 * 1024 * 1024 * 1024;
}

export async function POST(request: Request): Promise<NextResponse> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "BLOB_READ_WRITE_TOKEN is not configured" },
      { status: 501 },
    );
  }

  const body = (await request.json()) as Parameters<
    typeof handleUpload
  >[0]["body"];

  try {
    const json = await handleUpload({
      request,
      body,
      token,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          "video/mp4",
          "video/webm",
          "video/quicktime",
          "video/x-msvideo",
          "video/x-matroska",
        ],
        maximumSizeInBytes: maxBytes(),
        addRandomSuffix: true,
      }),
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(json);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Blob upload error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
