import { databaseConfigured } from "@/lib/server/db";
import { ensureAnalysisWorkerRunning } from "@/lib/server/analysis-worker";
import {
  deleteVideoWithArtifacts,
  getVideoDetail,
} from "@/lib/server/video-service";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  context: { params: Promise<{ videoId: string }> },
) {
  if (!databaseConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_URL is not configured." },
      { status: 503 },
    );
  }

  ensureAnalysisWorkerRunning();
  const { videoId } = await context.params;
  const detail = await getVideoDetail(videoId);
  if (!detail) {
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  }

  return NextResponse.json({ video: detail });
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ videoId: string }> },
) {
  if (!databaseConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_URL is not configured." },
      { status: 503 },
    );
  }

  const { videoId } = await context.params;
  await deleteVideoWithArtifacts(videoId);
  return NextResponse.json({ ok: true });
}
