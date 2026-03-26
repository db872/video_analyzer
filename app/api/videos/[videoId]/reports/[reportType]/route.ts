import {
  databaseConfigured,
  getLatestReportForVideo,
} from "@/lib/server/db";
import { NextRequest, NextResponse } from "next/server";

type ReportType = "bugReport" | "objectModelReport" | "timelineReport";

function isReportType(value: string): value is ReportType {
  return (
    value === "bugReport" ||
    value === "objectModelReport" ||
    value === "timelineReport"
  );
}

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ videoId: string; reportType: string }> },
) {
  if (!databaseConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_URL is not configured." },
      { status: 503 },
    );
  }

  const { videoId, reportType } = await context.params;
  if (!isReportType(reportType)) {
    return NextResponse.json({ error: "Unknown report type" }, { status: 404 });
  }

  const report = await getLatestReportForVideo(videoId, reportType);
  if (!report) {
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  }

  const format = req.nextUrl.searchParams.get("format") ?? "json";
  if (format === "html") {
    return new NextResponse(report.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${reportType}.html"`,
      },
    });
  }

  return NextResponse.json(report.content, {
    headers: {
      "Content-Disposition": `attachment; filename="${reportType}.json"`,
    },
  });
}
