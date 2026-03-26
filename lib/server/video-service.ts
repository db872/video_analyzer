import { randomUUID } from "crypto";
import { readFile, rm } from "fs/promises";
import { basename } from "path";
import { analyzePreparedMedia } from "@/lib/gemini-analyze";
import { guessAudioMime, guessImageMime, guessVideoMime } from "@/lib/mime";
import {
  attachSourceArtifact,
  createAnalysisRun,
  createVideo,
  deleteVideo,
  getVideoDetail,
  insertArtifact,
  listArtifactsForVideo,
  listVideos,
  persistAnalysis,
  updateAnalysisRun,
  updateVideoStatus,
} from "@/lib/server/db";
import {
  createWorkingDir,
  extractBoostedAudio,
  extractScreenshots,
} from "@/lib/server/ffmpeg";
import {
  deleteStoredArtifact,
  materializeArtifactToTempFile,
  storeBuffer,
  storeWebFile,
} from "@/lib/server/storage";
import {
  renderBugReportHtml,
  renderObjectModelReportHtml,
  renderTimelineReportHtml,
} from "@/lib/server/reports";
import type { StoredArtifact } from "@/lib/types";

const ANALYSIS_CONFIG_VERSION = "v1-memory-pipeline";

function getScreenshotIntervalSec() {
  const value = Number(process.env.SCREENSHOT_INTERVAL_SEC ?? "8");
  return Number.isFinite(value) && value > 0 ? value : 8;
}

function getMaxScreenshots() {
  const value = Number(process.env.MAX_SCREENSHOTS ?? "16");
  return Number.isFinite(value) && value > 0 ? value : 16;
}

function defaultVideoTitle(filename: string) {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  return base || `Video ${randomUUID().slice(0, 8)}`;
}

function sourceFilenameFromArtifact(artifact: StoredArtifact) {
  const original =
    typeof artifact.metadata.originalFilename === "string"
      ? artifact.metadata.originalFilename
      : null;
  return original ?? basename(artifact.storageKey) ?? `${artifact.id}.mp4`;
}

export async function createVideoFromUpload(params: {
  file: File;
  title?: string;
}) {
  const videoId = await createVideo({
    title: params.title?.trim() || defaultVideoTitle(params.file.name),
  });

  const stored = await storeWebFile({
    file: params.file,
    prefix: `videos/${videoId}/source`,
    mimeType: params.file.type || guessVideoMime(params.file.name),
  });

  const sourceArtifact = await insertArtifact({
    videoId,
    kind: "source_video",
    storageBackend: stored.storageBackend,
    storageKey: stored.storageKey,
    publicUrl: stored.publicUrl,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    metadata: stored.metadata,
  });

  await attachSourceArtifact(videoId, sourceArtifact.id);
  return getVideoDetail(videoId);
}

export async function createVideoFromBlobReference(params: {
  title: string;
  blobUrl: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename: string;
}) {
  const videoId = await createVideo({
    title: params.title.trim() || defaultVideoTitle(params.originalFilename),
  });

  const sourceArtifact = await insertArtifact({
    videoId,
    kind: "source_video",
    storageBackend: "blob",
    storageKey: params.storageKey,
    publicUrl: params.blobUrl,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
    metadata: {
      originalFilename: params.originalFilename,
    },
  });

  await attachSourceArtifact(videoId, sourceArtifact.id);
  return getVideoDetail(videoId);
}

export async function deleteVideoWithArtifacts(videoId: string) {
  const artifacts = await listArtifactsForVideo(videoId);
  for (const artifact of artifacts) {
    await deleteStoredArtifact(artifact).catch(() => {});
  }
  await deleteVideo(videoId);
}

export async function runAnalysisForVideo(videoId: string) {
  const detail = await getVideoDetail(videoId);
  if (!detail) {
    throw new Error("Video not found");
  }

  console.log("[analysis] starting run", {
    videoId,
    title: detail.title,
    sourceUrl: detail.sourceArtifact.publicUrl,
  });

  await updateVideoStatus(videoId, "processing");
  const runId = await createAnalysisRun({
    videoId,
    configVersion: ANALYSIS_CONFIG_VERSION,
  });

  let workingDir: string | null = null;
  let sourcePath: string | null = null;

  try {
    await updateAnalysisRun(runId, {
      status: "processing",
      stage: "Loading source video",
    });
    console.log("[analysis] loading source video", { videoId, runId });

    workingDir = await createWorkingDir("pm-video-analyzer");
    const sourceFilename = sourceFilenameFromArtifact(detail.sourceArtifact);
    sourcePath = await materializeArtifactToTempFile({
      artifact: detail.sourceArtifact,
      filename: sourceFilename,
    });

    await updateAnalysisRun(runId, {
      stage: "Boosting audio",
    });
    console.log("[analysis] boosting audio", { videoId, runId });
    const audioPath = await extractBoostedAudio({
      videoPath: sourcePath,
      outputDir: workingDir,
    });
    const audioBuffer = await readFile(audioPath);
    const audioStored = await storeBuffer({
      buffer: audioBuffer,
      prefix: `videos/${videoId}/runs/${runId}/audio`,
      filename: "boosted-audio.wav",
      mimeType: guessAudioMime("boosted-audio.wav"),
      metadata: {
        sourceVideoId: videoId,
        analysisRunId: runId,
      },
    });
    await insertArtifact({
      videoId,
      analysisRunId: runId,
      kind: "boosted_audio",
      storageBackend: audioStored.storageBackend,
      storageKey: audioStored.storageKey,
      publicUrl: audioStored.publicUrl,
      mimeType: audioStored.mimeType,
      sizeBytes: audioStored.sizeBytes,
      metadata: audioStored.metadata,
    });
    console.log("[analysis] stored boosted audio", {
      videoId,
      runId,
      audioPath,
      sizeBytes: audioStored.sizeBytes,
    });

    await updateAnalysisRun(runId, {
      stage: "Extracting screenshots",
    });
    console.log("[analysis] extracting screenshots", { videoId, runId });
    const rawScreenshots = await extractScreenshots({
      videoPath: sourcePath,
      outputDir: workingDir,
      intervalSec: getScreenshotIntervalSec(),
      maxFrames: getMaxScreenshots(),
    });

    const screenshots = [];
    for (const rawScreenshot of rawScreenshots) {
      const fileBuffer = await readFile(rawScreenshot.path);
      const stored = await storeBuffer({
        buffer: fileBuffer,
        prefix: `videos/${videoId}/runs/${runId}/screenshots`,
        filename: rawScreenshot.filename,
        mimeType: guessImageMime(rawScreenshot.filename),
        metadata: {
          timestampSec: rawScreenshot.timestampSec,
          analysisRunId: runId,
        },
      });
      const artifact = await insertArtifact({
        videoId,
        analysisRunId: runId,
        kind: "screenshot",
        storageBackend: stored.storageBackend,
        storageKey: stored.storageKey,
        publicUrl: stored.publicUrl,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        metadata: stored.metadata,
      });
      screenshots.push({
        artifactId: artifact.id,
        filePath: rawScreenshot.path,
        mimeType: artifact.mimeType,
        timestampSec: rawScreenshot.timestampSec,
      });
    }
    console.log("[analysis] stored screenshots", {
      videoId,
      runId,
      screenshotCount: screenshots.length,
    });

    await updateAnalysisRun(runId, {
      stage: "Analyzing audio and screenshots with Gemini",
    });
    console.log("[analysis] starting Gemini analysis", {
      videoId,
      runId,
      screenshotCount: screenshots.length,
    });
    const analysis = await analyzePreparedMedia({
      audioPath,
      audioMimeType: guessAudioMime(audioPath),
      workingDir: workingDir!,
      screenshots,
    });
    console.log("[analysis] Gemini analysis complete", {
      videoId,
      runId,
      transcriptSegments: analysis.transcript.length,
      moments: analysis.moments.length,
      entities: analysis.entities.length,
    });

    await updateAnalysisRun(runId, {
      stage: "Persisting memory and reports",
    });
    console.log("[analysis] persisting results", { videoId, runId });
    await persistAnalysis(runId, analysis, {
      bugReport: renderBugReportHtml(analysis.reports.bugReport),
      objectModelReport: renderObjectModelReportHtml(
        analysis.reports.objectModelReport,
      ),
      timelineReport: renderTimelineReportHtml(analysis.reports.timelineReport),
    });

    await updateAnalysisRun(runId, {
      status: "completed",
      stage: "Completed",
      error: null,
      completed: true,
    });
    await updateVideoStatus(videoId, "ready");
    console.log("[analysis] run completed", { videoId, runId });

    return getVideoDetail(videoId);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Analysis pipeline failed";
    console.error("[analysis] run failed", {
      videoId,
      runId,
      error: message,
    });
    await updateAnalysisRun(runId, {
      status: "failed",
      stage: "Failed",
      error: message,
    }).catch(() => {});
    await updateVideoStatus(videoId, "failed").catch(() => {});
    throw error;
  } finally {
    if (workingDir) {
      await rm(workingDir, { recursive: true, force: true }).catch(() => {});
    }
    if (sourcePath) {
      await rm(sourcePath, { force: true }).catch(() => {});
    }
  }
}

export { getVideoDetail, listVideos };
