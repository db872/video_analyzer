import { analyzeMomentsAndFlow } from "@/lib/analysis/moments-and-flow";
import { buildObjectModel } from "@/lib/analysis/object-model";
import { understandScreenshot } from "@/lib/analysis/screenshot-understanding";
import { transcribeAudioFile } from "@/lib/analysis/transcribe";
import {
  analysisResultSchema,
  type AnalysisResult,
  type ScreenshotInsight,
} from "@/lib/types";
import { buildReports } from "@/lib/server/reports";

export async function analyzePreparedMedia(params: {
  audioPath: string;
  audioMimeType: string;
  workingDir: string;
  screenshots: Array<{
    artifactId: string;
    filePath: string;
    mimeType: string;
    timestampSec: number;
  }>;
}): Promise<AnalysisResult> {
  const transcript = await transcribeAudioFile({
    filePath: params.audioPath,
    mimeType: params.audioMimeType,
    outputDir: params.workingDir,
  });

  const screenshotInsights: ScreenshotInsight[] = [];
  for (const screenshot of params.screenshots) {
    const insight = await understandScreenshot({
      filePath: screenshot.filePath,
      mimeType: screenshot.mimeType,
      timestampSec: screenshot.timestampSec,
    });

    screenshotInsights.push({
      ...insight,
      artifactId: screenshot.artifactId,
    });
  }

  const { flowSteps, moments } = await analyzeMomentsAndFlow({
    transcript,
    screenshots: screenshotInsights,
  });

  const { entities, relationships } = await buildObjectModel({
    transcript,
    screenshots: screenshotInsights,
  });

  const reports = buildReports({
    transcript,
    screenshots: screenshotInsights,
    flowSteps,
    moments,
    entities,
    relationships,
  });

  return analysisResultSchema.parse({
    transcript,
    screenshots: screenshotInsights,
    flowSteps,
    moments,
    entities,
    relationships,
    reports,
  });
}
