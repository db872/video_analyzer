import { randomUUID } from "crypto";
import { readFile, rm } from "fs/promises";
import { basename } from "path";
import {
  analyzePreparedMedia,
  analyzePromptedMedia,
  analyzeYouTubeMedia,
  type AnalyzeModeResult,
} from "@/lib/gemini-analyze";
import { guessAudioMime, guessVideoMime } from "@/lib/mime";
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
} from "@/lib/server/ffmpeg";
import {
  deleteStoredArtifact,
  materializeArtifactToTempFile,
  storeBuffer,
  storeWebFile,
} from "@/lib/server/storage";
import { materializeYouTubeVideoToTempFile } from "@/lib/server/youtube";
import {
  renderBugReportHtml,
  renderObjectModelReportHtml,
  renderTimelineReportHtml,
} from "@/lib/server/reports";
import type { AnalysisMode, AnalysisResult, StoredArtifact } from "@/lib/types";
import {
  getVideoSourceKind,
  getYouTubeVideoId,
  normalizeYouTubeUrl,
} from "@/lib/video-source";

const ANALYSIS_CONFIG_VERSION_BY_MODE: Record<AnalysisMode, string> = {
  pm_report: "v2-transcript-plus-clips",
  analyze: "v3-prompted-snapshots",
};

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

function defaultYouTubeTitle(url: string) {
  const videoId = getYouTubeVideoId(url);
  return videoId ? `YouTube ${videoId}` : "YouTube video";
}

async function attachScreenshotArtifacts(params: {
  videoId: string;
  runId: string;
  analysis: AnalysisResult;
  screenshotImagePaths: Array<string | null>;
}) {
  const screenshots = await Promise.all(
    params.analysis.screenshots.map(async (screenshot, index) => {
      const imagePath = params.screenshotImagePaths[index];
      if (!imagePath) return screenshot;

      const buffer = await readFile(imagePath);
      const stored = await storeBuffer({
        buffer,
        prefix: `videos/${params.videoId}/runs/${params.runId}/screenshots`,
        filename: `snapshot-${String(index).padStart(3, "0")}.jpg`,
        mimeType: "image/jpeg",
        metadata: {
          sourceVideoId: params.videoId,
          analysisRunId: params.runId,
          timestampSec: screenshot.timestampSec,
        },
      });
      const artifact = await insertArtifact({
        videoId: params.videoId,
        analysisRunId: params.runId,
        kind: "screenshot",
        storageBackend: stored.storageBackend,
        storageKey: stored.storageKey,
        publicUrl: stored.publicUrl,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        metadata: stored.metadata,
      });

      return {
        ...screenshot,
        artifactId: artifact.id,
        imageUrl: artifact.publicUrl,
      };
    }),
  );

  return {
    ...params.analysis,
    screenshots,
  } satisfies AnalysisResult;
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

export async function createVideoFromYouTubeUrl(params: {
  youtubeUrl: string;
  title?: string;
}) {
  const normalizedUrl = normalizeYouTubeUrl(params.youtubeUrl);
  if (!normalizedUrl) {
    throw new Error("Invalid YouTube URL");
  }

  const videoId = await createVideo({
    title: params.title?.trim() || defaultYouTubeTitle(normalizedUrl),
  });

  const youtubeVideoId = getYouTubeVideoId(normalizedUrl);
  const sourceArtifact = await insertArtifact({
    videoId,
    kind: "source_video",
    storageBackend: "external",
    storageKey: youtubeVideoId ? `youtube/${youtubeVideoId}` : normalizedUrl,
    publicUrl: normalizedUrl,
    mimeType: "video/youtube",
    sizeBytes: 0,
    metadata: {
      sourceType: "youtube",
      youtubeVideoId,
      originalUrl: params.youtubeUrl,
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

export async function runAnalysisForVideo(
  videoId: string,
  options?: {
    mode?: AnalysisMode;
    prompt?: string | null;
  },
) {
  const detail = await getVideoDetail(videoId);
  if (!detail) {
    throw new Error("Video not found");
  }

  const mode = options?.mode ?? "pm_report";
  const prompt =
    mode === "analyze"
      ? options?.prompt?.trim() || "Capture interesting product notes and snapshots."
      : null;

  console.log("[analysis] starting run", {
    videoId,
    title: detail.title,
    sourceUrl: detail.sourceArtifact.publicUrl,
    mode,
  });

  await updateVideoStatus(videoId, "processing");
  const runId = await createAnalysisRun({
    videoId,
    configVersion: ANALYSIS_CONFIG_VERSION_BY_MODE[mode],
    mode,
    prompt,
  });

  let workingDir: string | null = null;
  let sourcePath: string | null = null;

  try {
    await updateAnalysisRun(runId, {
      status: "processing",
      stage: "Loading source video",
    });
    console.log("[analysis] loading source video", { videoId, runId });

    const sourceKind = getVideoSourceKind(detail.sourceArtifact);
    let analysisResult: AnalyzeModeResult;

    if (sourceKind === "youtube") {
      if (mode === "analyze") {
        workingDir = await createWorkingDir("pm-video-analyzer");

        await updateAnalysisRun(runId, {
          stage: "Downloading YouTube video for screenshot extraction",
        });
        console.log("[analysis] downloading YouTube video", {
          videoId,
          runId,
          videoUrl: detail.sourceArtifact.publicUrl,
        });
        sourcePath = await materializeYouTubeVideoToTempFile({
          videoUrl: detail.sourceArtifact.publicUrl,
          outputDir: workingDir,
        });

        await updateAnalysisRun(runId, {
          stage: "Boosting audio",
        });
        console.log("[analysis] boosting downloaded YouTube audio", {
          videoId,
          runId,
        });
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
            sourceType: "youtube",
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

        await updateAnalysisRun(runId, {
          stage: "Capturing prompted notes and screenshots",
        });
        console.log("[analysis] starting downloaded YouTube analyze mode", {
          videoId,
          runId,
          mode,
        });
        analysisResult = await analyzePromptedMedia({
          sourceVideoPath: sourcePath,
          audioPath,
          audioMimeType: guessAudioMime(audioPath),
          workingDir,
          userPrompt: prompt ?? "Capture interesting product notes and snapshots.",
        });
      } else {
        await updateAnalysisRun(runId, {
          stage: "Analyzing YouTube video with Gemini",
        });
        console.log("[analysis] starting Gemini YouTube analysis", {
          videoId,
          runId,
          videoUrl: detail.sourceArtifact.publicUrl,
          mode,
        });
        analysisResult = {
          analysis: await analyzeYouTubeMedia({
            videoUrl: detail.sourceArtifact.publicUrl,
          }),
          screenshotImagePaths: [],
        };
      }
    } else {
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
        stage:
          mode === "analyze"
            ? "Capturing prompted notes and snapshots"
            : "Analyzing transcript and targeted clips with Gemini",
      });
      console.log("[analysis] starting Gemini analysis", { videoId, runId, mode });
      analysisResult =
        mode === "analyze"
          ? await analyzePromptedMedia({
              sourceVideoPath: sourcePath,
              audioPath,
              audioMimeType: guessAudioMime(audioPath),
              workingDir,
              userPrompt: prompt ?? "Capture interesting product notes and snapshots.",
            })
          : {
              analysis: await analyzePreparedMedia({
                sourceVideoPath: sourcePath,
                audioPath,
                audioMimeType: guessAudioMime(audioPath),
                workingDir,
              }),
              screenshotImagePaths: [],
            };
    }

    const analysis = await attachScreenshotArtifacts({
      videoId,
      runId,
      analysis: analysisResult.analysis,
      screenshotImagePaths: analysisResult.screenshotImagePaths,
    });

    console.log("[analysis] Gemini analysis complete", {
      videoId,
      runId,
      transcriptSegments: analysis.transcript.length,
      moments: analysis.moments.length,
      entities: analysis.entities.length,
      screenshots: analysis.screenshots.length,
    });

    await updateAnalysisRun(runId, {
      stage: "Persisting memory and reports",
    });
    console.log("[analysis] persisting results", { videoId, runId, mode });
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
    console.log("[analysis] run completed", { videoId, runId, mode });

    return getVideoDetail(videoId);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Analysis pipeline failed";
    console.error("[analysis] run failed", {
      videoId,
      runId,
      mode,
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
