import { databaseConfigured } from "@/lib/server/db";
import { runAnalysisForVideo } from "@/lib/server/video-service";
import { analysisModeSchema } from "@/lib/types";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

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

  try {
    let body: { mode?: string; prompt?: string } = {};
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      body = ((await req.json().catch(() => ({}))) ?? {}) as {
        mode?: string;
        prompt?: string;
      };
    }

    const { videoId } = await context.params;
    const video = await runAnalysisForVideo(videoId, {
      mode: body.mode ? analysisModeSchema.parse(body.mode) : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    });
    return NextResponse.json({ video });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Analysis pipeline failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
