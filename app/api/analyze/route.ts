import { guessVideoMime } from "@/lib/mime";
import { databaseConfigured } from "@/lib/server/db";
import { ensureAnalysisWorkerRunning } from "@/lib/server/analysis-worker";
import {
  createVideoFromBlobReference,
  createVideoFromUpload,
  createVideoFromYouTubeUrl,
  enqueueAnalysisForVideo,
} from "@/lib/server/video-service";
import { analysisModeSchema } from "@/lib/types";
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
    ensureAnalysisWorkerRunning();
    const contentType = req.headers.get("content-type") ?? "";
    let videoId: string;
    let mode: "pm_report" | "analyze" | undefined;
    let prompt: string | undefined;

    if (contentType.includes("application/json")) {
      const body = (await req.json()) as {
        blobUrl?: string;
        youtubeUrl?: string;
        mode?: string;
        prompt?: string;
      };
      mode = body.mode ? analysisModeSchema.parse(body.mode) : undefined;
      prompt = typeof body.prompt === "string" ? body.prompt : undefined;

      if (typeof body.youtubeUrl === "string" && body.youtubeUrl.length > 0) {
        const created = await createVideoFromYouTubeUrl({
          youtubeUrl: body.youtubeUrl,
        });

        if (!created) {
          throw new Error("Could not create persisted YouTube video");
        }
        videoId = created.id;
      } else {
        const url = body.blobUrl;
        if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
          return NextResponse.json(
            { error: "Expected JSON body { blobUrl: string } or { youtubeUrl: string }" },
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
      }
    } else if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const modeValue = form.get("mode");
      const promptValue = form.get("prompt");
      mode =
        typeof modeValue === "string"
          ? analysisModeSchema.parse(modeValue)
          : undefined;
      prompt = typeof promptValue === "string" ? promptValue : undefined;
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
        {
          error:
            "Use multipart/form-data with file field or JSON { blobUrl } / { youtubeUrl }",
        },
        { status: 415 },
      );
    }

    const video = await enqueueAnalysisForVideo(videoId, { mode, prompt });
    return NextResponse.json({ video });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
