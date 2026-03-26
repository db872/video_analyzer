import { databaseConfigured } from "@/lib/server/db";
import { runAnalysisForVideo } from "@/lib/server/video-service";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  _req: Request,
  context: { params: Promise<{ videoId: string }> },
) {
  if (!databaseConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_URL is not configured." },
      { status: 503 },
    );
  }

  try {
    const { videoId } = await context.params;
    const video = await runAnalysisForVideo(videoId);
    return NextResponse.json({ video });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Analysis pipeline failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
