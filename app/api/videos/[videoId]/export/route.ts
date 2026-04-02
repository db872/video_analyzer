import { readFile, rm } from "fs/promises";
import { basename } from "path";
import { z } from "zod";
import { databaseConfigured, getVideoDetail } from "@/lib/server/db";
import { createWorkingDir, extractVideoClip } from "@/lib/server/ffmpeg";
import { materializeArtifactToTempFile } from "@/lib/server/storage";
import { getVideoSourceKind } from "@/lib/video-source";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  padSec: z.number().min(0).max(30).optional(),
});

function sourceFilenameFromArtifact(metadata: Record<string, unknown>, storageKey: string) {
  const originalFilename =
    typeof metadata.originalFilename === "string" ? metadata.originalFilename : null;
  return originalFilename ?? basename(storageKey) ?? "source.mp4";
}

function assertPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} path was not a valid string`);
  }
  return value;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ videoId: string }> },
) {
  if (!databaseConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_URL is not configured." },
      { status: 503 },
    );
  }

  let workingDir: string | null = null;
  let sourcePath: string | null = null;
  let clipPath: string | null = null;

  try {
    const { videoId } = await context.params;
    const body = requestSchema.parse(await req.json());
    const video = await getVideoDetail(videoId);

    if (!video) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    if (getVideoSourceKind(video.sourceArtifact) === "youtube") {
      return NextResponse.json(
        { error: "Clip export is currently only available for uploaded video files." },
        { status: 400 },
      );
    }

    const startSec = Math.max(0, body.startSec - (body.padSec ?? 0.5));
    const endSec = Math.max(startSec + 0.25, body.endSec + (body.padSec ?? 0.5));

    console.log("[export] starting clip export", {
      videoId,
      startSec,
      endSec,
    });

    workingDir = await createWorkingDir("pm-video-export");
    sourcePath = assertPath(
      await materializeArtifactToTempFile({
        artifact: video.sourceArtifact,
        filename: sourceFilenameFromArtifact(
          video.sourceArtifact.metadata,
          video.sourceArtifact.storageKey,
        ),
      }),
      "source",
    );

    clipPath = assertPath(
      await extractVideoClip({
        videoPath: sourcePath,
        outputDir: workingDir,
        startSec,
        endSec,
        filename: "exported-clip.mp4",
      }),
      "clip",
    );

    const clipBuffer = await readFile(clipPath);
    const clipBytes = new Uint8Array(clipBuffer);

    console.log("[export] clip export complete", {
      videoId,
      startSec,
      endSec,
      sizeBytes: clipBuffer.byteLength,
    });

    return new Response(clipBytes, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="exported-clip.mp4"',
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Clip export failed";
    console.error("[export] clip export failed", { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (clipPath) {
      await rm(clipPath, { force: true }).catch(() => {});
    }
    if (sourcePath) {
      await rm(sourcePath, { force: true }).catch(() => {});
    }
    if (workingDir) {
      await rm(workingDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
