import { randomUUID } from "crypto";
import {
  ANALYSIS_CONFIG_VERSION_BY_MODE,
} from "@/lib/server/analysis-pipeline";
import { ensureAnalysisWorkerRunning } from "@/lib/server/analysis-worker";
import { guessVideoMime } from "@/lib/mime";
import {
  attachSourceArtifact,
  createAnalysisRun,
  createAnalysisJob,
  createVideo,
  deleteVideo,
  getVideoDetail,
  insertArtifact,
  listArtifactsForVideo,
  listVideos,
  updateVideoStatus,
} from "@/lib/server/db";
import {
  deleteStoredArtifact,
  storeWebFile,
} from "@/lib/server/storage";
import type { AnalysisMode } from "@/lib/types";
import { getYouTubeVideoId, normalizeYouTubeUrl } from "@/lib/video-source";

function defaultVideoTitle(filename: string) {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  return base || `Video ${randomUUID().slice(0, 8)}`;
}

function defaultYouTubeTitle(url: string) {
  const videoId = getYouTubeVideoId(url);
  return videoId ? `YouTube ${videoId}` : "YouTube video";
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

export async function enqueueAnalysisForVideo(
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

  if (detail.latestRun && ["queued", "processing"].includes(detail.latestRun.status)) {
    ensureAnalysisWorkerRunning();
    return detail;
  }

  await updateVideoStatus(videoId, "processing");
  const runId = await createAnalysisRun({
    videoId,
    configVersion: ANALYSIS_CONFIG_VERSION_BY_MODE[mode],
    mode,
    prompt,
  });
  await createAnalysisJob({
    analysisRunId: runId,
    jobType: "prepare_media",
    payload: {
      videoId,
      mode,
      prompt,
    },
  });
  ensureAnalysisWorkerRunning();
  return getVideoDetail(videoId);
}

export { getVideoDetail, listVideos };
