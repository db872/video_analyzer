import { guessVideoMime } from "@/lib/mime";
import { databaseConfigured } from "@/lib/server/db";
import {
  createVideoFromBlobReference,
  createVideoFromUpload,
  runAnalysisForVideo,
} from "@/lib/server/video-service";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!databaseConfigured()) {
    return NextResponse.json(
      {
        error:
          "DATABASE_URL is not configured. Add a Neon connection string before running analysis.",
      },
      { status: 503 },
    );
  }

  try {
    const contentType = req.headers.get("content-type") ?? "";
    let videoId: string;

    if (contentType.includes("application/json")) {
      const body = (await req.json()) as { blobUrl?: string };
      const url = body.blobUrl;
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
        return NextResponse.json(
          { error: "Expected JSON body { blobUrl: string }" },
          { status: 400 },
        );
      }

      const pathname = new URL(url).pathname;
      const filename = pathname.split("/").pop() ?? "video.mp4";
      const created = await createVideoFromBlobReference({
        title: filename,
        blobUrl: url,
        storageKey: pathname.replace(/^\//, ""),
        mimeType: guessVideoMime(filename),
        sizeBytes: 0,
        originalFilename: filename,
      });

      if (!created) {
        throw new Error("Could not create persisted video");
      }
      videoId = created.id;
    } else if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: 'Missing "file" in multipart form' },
          { status: 400 },
        );
      }

      const created = await createVideoFromUpload({
        file,
        title: file.name.replace(/\.[^.]+$/, ""),
      });
      if (!created) {
        throw new Error("Could not create persisted video");
      }
      videoId = created.id;
    } else {
      return NextResponse.json(
        { error: "Use multipart/form-data with file field or JSON { blobUrl }" },
        { status: 415 },
      );
    }

    const video = await runAnalysisForVideo(videoId);
    return NextResponse.json({ video });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
