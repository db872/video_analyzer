import { databaseConfigured } from "@/lib/server/db";
import {
  createVideoFromBlobReference,
  createVideoFromUpload,
  createVideoFromYouTubeUrl,
  listVideos,
} from "@/lib/server/video-service";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET() {
  if (!databaseConfigured()) {
    return NextResponse.json({ videos: [] });
  }

  const videos = await listVideos();
  return NextResponse.json({ videos });
}

export async function POST(req: NextRequest) {
  if (!databaseConfigured()) {
    return NextResponse.json(
      {
        error:
          "DATABASE_URL is not configured. Add a Neon connection string before creating videos.",
      },
      { status: 503 },
    );
  }

  try {
    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      const body = (await req.json()) as {
        title?: string;
        blobUrl?: string;
        youtubeUrl?: string;
        storageKey?: string;
        mimeType?: string;
        sizeBytes?: number;
        originalFilename?: string;
      };

      if (body.youtubeUrl) {
        const detail = await createVideoFromYouTubeUrl({
          youtubeUrl: body.youtubeUrl,
          title: body.title,
        });

        return NextResponse.json({ video: detail }, { status: 201 });
      }

      if (
        !body.blobUrl ||
        !body.storageKey ||
        !body.mimeType ||
        !body.originalFilename
      ) {
        return NextResponse.json(
          { error: "Missing blob upload metadata" },
          { status: 400 },
        );
      }

      const detail = await createVideoFromBlobReference({
        title: body.title ?? body.originalFilename,
        blobUrl: body.blobUrl,
        storageKey: body.storageKey,
        mimeType: body.mimeType,
        sizeBytes: Number(body.sizeBytes ?? 0),
        originalFilename: body.originalFilename,
      });

      return NextResponse.json({ video: detail }, { status: 201 });
    }

    const form = await req.formData();
    const file = form.get("file");
    const title = form.get("title");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'Missing "file" in multipart form' },
        { status: 400 },
      );
    }

    const detail = await createVideoFromUpload({
      file,
      title: typeof title === "string" ? title : undefined,
    });

    return NextResponse.json({ video: detail }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not create video";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
