import {
  analyzeTargetClip,
  analyzeTargetClipFromVideoUrl,
  type ClipFinding,
} from "@/lib/analysis/clip-understanding";
import { analyzeMomentsAndFlow } from "@/lib/analysis/moments-and-flow";
import { buildObjectModel } from "@/lib/analysis/object-model";
import {
  analyzePromptedSnapshotsFromFile,
  analyzePromptedSnapshotsFromVideoUrl,
} from "@/lib/analysis/prompted-snapshots";
import { transcribeAudioFile, transcribeVideoUrl } from "@/lib/analysis/transcribe";
import {
  analysisResultSchema,
  type AnalysisResult,
} from "@/lib/types";
import { extractVideoClip } from "@/lib/server/ffmpeg";
import { buildReports } from "@/lib/server/reports";

export type AnalyzeModeResult = {
  analysis: AnalysisResult;
  screenshotImagePaths: Array<string | null>;
};

function getClipPaddingSec() {
  const value = Number(process.env.CLIP_CONTEXT_PAD_SEC ?? "8");
  return Number.isFinite(value) && value >= 0 ? value : 8;
}

function getMaxClipAnalyses() {
  const value = Number(process.env.MAX_CLIP_ANALYSES ?? "6");
  return Number.isFinite(value) && value > 0 ? value : 6;
}

function transcriptExcerptForRange(
  transcript: AnalysisResult["transcript"],
  startSec: number,
  endSec: number,
) {
  return transcript
    .filter((segment) => segment.endSec > startSec && segment.startSec < endSec)
    .map(
      (segment) =>
        `[${segment.startSec.toFixed(1)}-${segment.endSec.toFixed(1)}] ${segment.text}`,
    )
    .slice(0, 20);
}

async function analyzeTargetedClips(params: {
  sourceVideoPath: string;
  workingDir: string;
  transcript: AnalysisResult["transcript"];
  moments: AnalysisResult["moments"];
}) {
  const clipFindings: ClipFinding[] = [];
  const clipPadSec = getClipPaddingSec();
  const limitedMoments = params.moments.slice(0, getMaxClipAnalyses());

  for (const [index, moment] of limitedMoments.entries()) {
    const clipStartSec = Math.max(0, moment.startSec - clipPadSec);
    const clipEndSec = moment.endSec + clipPadSec;
    const clipPath = await extractVideoClip({
      videoPath: params.sourceVideoPath,
      outputDir: params.workingDir,
      startSec: clipStartSec,
      endSec: clipEndSec,
      filename: `target-clip-${String(index).padStart(3, "0")}.mp4`,
    });

    const finding = await analyzeTargetClip({
      filePath: clipPath,
      mimeType: "video/mp4",
      startSec: clipStartSec,
      endSec: clipEndSec,
      transcriptExcerpt: transcriptExcerptForRange(
        params.transcript,
        clipStartSec,
        clipEndSec,
      ),
      contextLabel: `${moment.category}-${index + 1}`,
    });

    clipFindings.push(finding);
  }

  return clipFindings;
}

async function analyzeTargetedVideoUrlRanges(params: {
  videoUrl: string;
  transcript: AnalysisResult["transcript"];
  moments: AnalysisResult["moments"];
}) {
  const clipFindings: ClipFinding[] = [];
  const limitedMoments = params.moments.slice(0, getMaxClipAnalyses());

  for (const [index, moment] of limitedMoments.entries()) {
    const finding = await analyzeTargetClipFromVideoUrl({
      videoUrl: params.videoUrl,
      startSec: Math.max(0, moment.startSec),
      endSec: moment.endSec,
      transcriptExcerpt: transcriptExcerptForRange(
        params.transcript,
        moment.startSec,
        moment.endSec,
      ),
      contextLabel: `${moment.category}-${index + 1}`,
    });

    clipFindings.push(finding);
  }

  return clipFindings;
}

function mergeMomentsWithClipFindings(params: {
  moments: AnalysisResult["moments"];
  clipFindings: ClipFinding[];
}) {
  return params.moments.map((moment) => {
    const match = params.clipFindings.find(
      (finding) =>
        finding.startSec <= moment.endSec && finding.endSec >= moment.startSec,
    );

    if (!match) return moment;

    return {
      ...moment,
      title: match.title || moment.title,
      summary: match.summary || moment.summary,
      evidence: Array.from(new Set([...moment.evidence, ...match.visualEvidence])),
      acceptanceCriteria:
        match.acceptanceCriteria.length > 0
          ? match.acceptanceCriteria
          : moment.acceptanceCriteria,
    };
  });
}

export async function analyzePreparedMedia(params: {
  sourceVideoPath: string;
  audioPath: string;
  audioMimeType: string;
  workingDir: string;
}): Promise<AnalysisResult> {
  const transcript = await transcribeAudioFile({
    filePath: params.audioPath,
    mimeType: params.audioMimeType,
    outputDir: params.workingDir,
  });

  const { flowSteps, moments } = await analyzeMomentsAndFlow({
    transcript,
  });
  const clipFindings = await analyzeTargetedClips({
    sourceVideoPath: params.sourceVideoPath,
    workingDir: params.workingDir,
    transcript,
    moments,
  });
  const enrichedMoments = mergeMomentsWithClipFindings({
    moments,
    clipFindings,
  });

  const { entities, relationships } = await buildObjectModel({
    transcript,
    clipFindings,
  });

  const reports = buildReports({
    transcript,
    flowSteps,
    screenshots: [],
    moments: enrichedMoments,
    entities,
    relationships,
  });

  return analysisResultSchema.parse({
    transcript,
    screenshots: [],
    flowSteps,
    moments: enrichedMoments,
    entities,
    relationships,
    reports,
  });
}

export async function analyzeYouTubeMedia(params: {
  videoUrl: string;
}): Promise<AnalysisResult> {
  const transcript = await transcribeVideoUrl({
    videoUrl: params.videoUrl,
  });

  const { flowSteps, moments } = await analyzeMomentsAndFlow({
    transcript,
  });
  const clipFindings = await analyzeTargetedVideoUrlRanges({
    videoUrl: params.videoUrl,
    transcript,
    moments,
  });
  const enrichedMoments = mergeMomentsWithClipFindings({
    moments,
    clipFindings,
  });

  const { entities, relationships } = await buildObjectModel({
    transcript,
    clipFindings,
  });

  const reports = buildReports({
    transcript,
    flowSteps,
    screenshots: [],
    moments: enrichedMoments,
    entities,
    relationships,
  });

  return analysisResultSchema.parse({
    transcript,
    screenshots: [],
    flowSteps,
    moments: enrichedMoments,
    entities,
    relationships,
    reports,
  });
}

export async function analyzePromptedMedia(params: {
  sourceVideoPath: string;
  audioPath: string;
  audioMimeType: string;
  workingDir: string;
  userPrompt: string;
}): Promise<AnalyzeModeResult> {
  const transcript = await transcribeAudioFile({
    filePath: params.audioPath,
    mimeType: params.audioMimeType,
    outputDir: params.workingDir,
  });

  const snapshotRun = await analyzePromptedSnapshotsFromFile({
    sourceVideoPath: params.sourceVideoPath,
    workingDir: params.workingDir,
    transcript,
    userPrompt: params.userPrompt,
  });

  return {
    analysis: analysisResultSchema.parse({
      transcript,
      screenshots: snapshotRun.snapshots,
      flowSteps: [],
      moments: [],
      entities: [],
      relationships: [],
      reports: {
        bugReport: {
          summary: "Prompted analyze mode does not generate bug tickets.",
          tickets: [],
        },
        objectModelReport: {
          summary: "Prompted analyze mode does not build an object model.",
          objects: [],
          relationships: [],
          unknowns: [],
        },
        timelineReport: {
          summary: snapshotRun.summary,
          highlights: snapshotRun.snapshots.map(
            (snapshot) =>
              `${snapshot.timestampSec.toFixed(1)}s: ${snapshot.caption}`,
          ),
        },
      },
    }),
    screenshotImagePaths: snapshotRun.snapshots.map(
      (snapshot) => snapshot.imagePath ?? null,
    ),
  };
}

export async function analyzePromptedYouTubeMedia(params: {
  videoUrl: string;
  userPrompt: string;
}): Promise<AnalyzeModeResult> {
  const transcript = await transcribeVideoUrl({
    videoUrl: params.videoUrl,
  });

  const snapshotRun = await analyzePromptedSnapshotsFromVideoUrl({
    videoUrl: params.videoUrl,
    transcript,
    userPrompt: params.userPrompt,
  });

  return {
    analysis: analysisResultSchema.parse({
      transcript,
      screenshots: snapshotRun.snapshots,
      flowSteps: [],
      moments: [],
      entities: [],
      relationships: [],
      reports: {
        bugReport: {
          summary: "Prompted analyze mode does not generate bug tickets.",
          tickets: [],
        },
        objectModelReport: {
          summary: "Prompted analyze mode does not build an object model.",
          objects: [],
          relationships: [],
          unknowns: [],
        },
        timelineReport: {
          summary: snapshotRun.summary,
          highlights: snapshotRun.snapshots.map(
            (snapshot) =>
              `${snapshot.timestampSec.toFixed(1)}s: ${snapshot.caption}`,
          ),
        },
      },
    }),
    screenshotImagePaths: snapshotRun.snapshots.map(() => null),
  };
}
