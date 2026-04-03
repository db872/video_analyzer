import { readFile, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
import {
  analyzeTargetClip,
  analyzeTargetClipFromVideoUrl,
  type ClipFinding,
} from "@/lib/analysis/clip-understanding";
import { analyzeMomentsAndFlow } from "@/lib/analysis/moments-and-flow";
import { buildObjectModel } from "@/lib/analysis/object-model";
import {
  analyzePromptedSnapshotFromFile,
  analyzePromptedSnapshotFromVideoUrl,
  selectInterestingSnapshots,
  type PromptedSnapshotResult,
  type SnapshotCandidate,
} from "@/lib/analysis/prompted-snapshots";
import {
  mergeTranscriptChunks,
  transcribeAudioChunk,
  transcribeVideoUrl,
} from "@/lib/analysis/transcribe";
import { guessAudioMime } from "@/lib/mime";
import {
  cancelQueuedAnalysisJobsForRun,
  completeAnalysisJob,
  createAnalysisJob,
  getAnalysisRun,
  getAnalysisRunOutput,
  getVideoDetail,
  insertArtifact,
  listAnalysisRunOutputsByPrefix,
  persistAnalysis,
  putAnalysisRunOutput,
  updateAnalysisRun,
  updateVideoStatus,
} from "@/lib/server/db";
import {
  extractBoostedAudio,
  extractVideoClip,
  splitAudioIntoChunks,
} from "@/lib/server/ffmpeg";
import {
  buildReports,
  renderBugReportHtml,
  renderObjectModelReportHtml,
  renderTimelineReportHtml,
} from "@/lib/server/reports";
import { readStoredArtifact, storeBuffer } from "@/lib/server/storage";
import { materializeYouTubeVideoToTempFile } from "@/lib/server/youtube";
import type {
  AnalysisJob,
  AnalysisMode,
  AnalysisResult,
  FlowStep,
  MemoryEntity,
  MemoryRelationship,
  Moment,
  TranscriptSegment,
} from "@/lib/types";
import { getVideoSourceKind } from "@/lib/video-source";

export const ANALYSIS_CONFIG_VERSION_BY_MODE: Record<AnalysisMode, string> = {
  pm_report: "v2-transcript-plus-clips",
  analyze: "v3-prompted-snapshots",
};

const OUTPUT_KEYS = {
  preparedMedia: "prepared_media",
  transcript: "transcript",
  momentsFlow: "moments_flow",
  clipBundle: "clip_bundle",
  objectModel: "object_model",
  snapshotSelection: "snapshot_selection",
  snapshotRun: "snapshot_run",
} as const;

type PreparedMediaOutput = {
  sourceKind: "file" | "youtube_url";
  sourceVideoUrl: string;
  sourceVideoPath: string | null;
  audioPath: string | null;
  audioMimeType: string | null;
  workingDir: string | null;
  userPrompt: string | null;
};

type TranscriptOutput = {
  transcript: TranscriptSegment[];
};

type MomentsFlowOutput = {
  flowSteps: FlowStep[];
  moments: Moment[];
};

type ClipFindingOutput = {
  momentIndex: number;
  finding: ClipFinding;
};

type ClipBundleOutput = {
  flowSteps: FlowStep[];
  moments: Moment[];
  clipFindings: ClipFinding[];
};

type ObjectModelOutput = {
  entities: MemoryEntity[];
  relationships: MemoryRelationship[];
};

type SnapshotSelectionOutput = {
  summary: string;
  candidates: Array<SnapshotCandidate & { index: number }>;
};

type SnapshotOutput = {
  snapshotIndex: number;
  snapshot: PromptedSnapshotResult;
};

type SnapshotRunOutput = {
  summary: string;
  snapshots: PromptedSnapshotResult[];
};

type PrepareMediaPayload = {
  videoId: string;
  mode: AnalysisMode;
  prompt: string | null;
};

type TranscribeAudioChunkPayload = {
  chunkIndex: number;
  totalChunks: number;
  filePath: string;
  mimeType: string;
  clipStartSec: number;
  clipEndSec: number;
};

type TranscribeVideoUrlPayload = {
  videoUrl: string;
};

type AnalyzeClipPayload = {
  momentIndex: number;
  clipStartSec: number;
  clipEndSec: number;
  contextLabel: string;
};

type AnalyzeSnapshotPayload = {
  snapshotIndex: number;
  candidate: SnapshotCandidate;
};

function getTranscriptionChunkSeconds() {
  const value = Number(process.env.TRANSCRIPTION_CHUNK_SEC ?? "120");
  return Number.isFinite(value) && value > 0 ? value : 120;
}

function getMaxClipAnalyses() {
  const value = Number(process.env.MAX_CLIP_ANALYSES ?? "6");
  return Number.isFinite(value) && value > 0 ? value : 6;
}

function getMaxPromptedSnapshots() {
  const value = Number(process.env.MAX_PROMPTED_SNAPSHOTS ?? "6");
  return Number.isFinite(value) && value > 0 ? value : 6;
}

function getClipPaddingSec() {
  const value = Number(process.env.CLIP_CONTEXT_PAD_SEC ?? "8");
  return Number.isFinite(value) && value >= 0 ? value : 8;
}

function defaultAnalyzePrompt() {
  return "Capture interesting product notes and snapshots.";
}

function sourceFilenameFromUrl(url: string) {
  return basename(new URL(url).pathname) || "source-video.mp4";
}

function sourceFilenameFromArtifact(
  sourceArtifact: NonNullable<Awaited<ReturnType<typeof getVideoDetail>>>["sourceArtifact"],
) {
  const original =
    typeof sourceArtifact.metadata.originalFilename === "string"
      ? sourceArtifact.metadata.originalFilename
      : null;
  return original ?? basename(sourceArtifact.storageKey) ?? "source-video.mp4";
}

function retryDelayForAttempt(attemptCount: number) {
  return Math.min(60, Math.max(5, attemptCount * 10));
}

export function getAnalysisJobMaxAttempts(job: AnalysisJob) {
  switch (job.jobType) {
    case "finalize_run":
      return 1;
    case "prepare_media":
      return 2;
    case "merge_transcript":
    case "merge_clip_findings":
    case "merge_snapshots":
    case "build_object_model":
    case "analyze_moments":
    case "select_snapshots":
      return 2;
    default:
      return 3;
  }
}

export function getAnalysisJobRetryDelaySec(job: AnalysisJob) {
  return retryDelayForAttempt(job.attemptCount);
}

function transcriptExcerptForRange(
  transcript: TranscriptSegment[],
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

function mergeMomentsWithClipFindings(params: {
  moments: Moment[];
  clipFindings: ClipFindingOutput[];
}) {
  const findingsByIndex = new Map(
    params.clipFindings.map((item) => [item.momentIndex, item.finding]),
  );

  return params.moments.map((moment, index) => {
    const match = findingsByIndex.get(index);
    if (!match) {
      return moment;
    }

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

async function createRunWorkingDir(runId: string) {
  const workingDir = join(tmpdir(), "pm-video-analyzer-runs", runId);
  await mkdir(workingDir, { recursive: true });
  return workingDir;
}

async function materializeSourceArtifactToRunFile(params: {
  runId: string;
  filename: string;
  sourceArtifact: NonNullable<Awaited<ReturnType<typeof getVideoDetail>>>["sourceArtifact"];
}) {
  const workingDir = await createRunWorkingDir(params.runId);
  const outputPath = join(workingDir, params.filename);
  const buffer = await readStoredArtifact(params.sourceArtifact);
  await writeFile(outputPath, buffer);
  return {
    outputPath,
    workingDir,
  };
}

export async function cleanupRunFiles(runId: string) {
  const prepared = await getAnalysisRunOutput<PreparedMediaOutput>(
    runId,
    OUTPUT_KEYS.preparedMedia,
  );

  if (!prepared?.workingDir) {
    return;
  }

  await rm(prepared.workingDir, { recursive: true, force: true }).catch(() => {});
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
      if (!imagePath) {
        return screenshot;
      }

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

async function queueTranscriptJobs(runId: string, prepared: PreparedMediaOutput) {
  if (prepared.sourceKind === "youtube_url") {
    const transcribeJobId = await createAnalysisJob({
      analysisRunId: runId,
      jobType: "transcribe_video_url",
      payload: {
        videoUrl: prepared.sourceVideoUrl,
      },
    });
    await createAnalysisJob({
      analysisRunId: runId,
      jobType: "merge_transcript",
      dependsOnJobIds: [transcribeJobId],
    });
    return;
  }

  if (!prepared.audioPath || !prepared.audioMimeType || !prepared.workingDir) {
    throw new Error("Prepared media is missing local audio context.");
  }

  const chunks = await splitAudioIntoChunks({
    audioPath: prepared.audioPath,
    outputDir: prepared.workingDir,
    chunkDurationSec: getTranscriptionChunkSeconds(),
  });

  const dependencyIds: string[] = [];
  for (const chunk of chunks) {
    const jobId = await createAnalysisJob({
      analysisRunId: runId,
      jobType: "transcribe_audio_chunk",
      payload: {
        chunkIndex: chunk.index,
        totalChunks: chunks.length,
        filePath: chunk.path,
        mimeType: prepared.audioMimeType,
        clipStartSec: chunk.startSec,
        clipEndSec: chunk.endSec,
      },
    });
    dependencyIds.push(jobId);
  }

  await createAnalysisJob({
    analysisRunId: runId,
    jobType: "merge_transcript",
    dependsOnJobIds: dependencyIds,
  });
}

async function handlePrepareMedia(job: AnalysisJob) {
  const payload = job.payload as PrepareMediaPayload;
  const detail = await getVideoDetail(payload.videoId);
  if (!detail) {
    throw new Error("Video not found");
  }

  await updateAnalysisRun(job.analysisRunId, {
    status: "processing",
    stage: "Loading source video",
    error: null,
  });

  const sourceKind = getVideoSourceKind(detail.sourceArtifact);
  const prompt =
    payload.mode === "analyze"
      ? payload.prompt?.trim() || defaultAnalyzePrompt()
      : null;

  if (sourceKind === "youtube" && payload.mode === "pm_report") {
    const prepared: PreparedMediaOutput = {
      sourceKind: "youtube_url",
      sourceVideoUrl: detail.sourceArtifact.publicUrl,
      sourceVideoPath: null,
      audioPath: null,
      audioMimeType: null,
      workingDir: null,
      userPrompt: null,
    };
    await putAnalysisRunOutput(job.analysisRunId, OUTPUT_KEYS.preparedMedia, prepared);
    await queueTranscriptJobs(job.analysisRunId, prepared);
    await completeAnalysisJob(job.id, {
      sourceKind: prepared.sourceKind,
    });
    return;
  }

  const filename =
    sourceKind === "youtube"
      ? sourceFilenameFromUrl(detail.sourceArtifact.publicUrl)
      : sourceFilenameFromArtifact(detail.sourceArtifact);

  const {
    outputPath: sourceVideoPath,
    workingDir,
  } =
    sourceKind === "youtube"
      ? await (async () => {
          const runWorkingDir = await createRunWorkingDir(job.analysisRunId);
          return {
            outputPath: await materializeYouTubeVideoToTempFile({
              videoUrl: detail.sourceArtifact.publicUrl,
              outputDir: runWorkingDir,
            }),
            workingDir: runWorkingDir,
          };
        })()
      : await materializeSourceArtifactToRunFile({
          runId: job.analysisRunId,
          filename,
          sourceArtifact: detail.sourceArtifact,
        });

  await updateAnalysisRun(job.analysisRunId, {
    status: "processing",
    stage: sourceKind === "youtube" ? "Downloading YouTube video" : "Boosting audio",
    error: null,
  });

  const audioPath = await extractBoostedAudio({
    videoPath: sourceVideoPath,
    outputDir: workingDir,
  });
  const audioBuffer = await readFile(audioPath);
  const audioStored = await storeBuffer({
    buffer: audioBuffer,
    prefix: `videos/${payload.videoId}/runs/${job.analysisRunId}/audio`,
    filename: "boosted-audio.wav",
    mimeType: guessAudioMime("boosted-audio.wav"),
    metadata: {
      sourceVideoId: payload.videoId,
      analysisRunId: job.analysisRunId,
      sourceType: sourceKind,
    },
  });
  await insertArtifact({
    videoId: payload.videoId,
    analysisRunId: job.analysisRunId,
    kind: "boosted_audio",
    storageBackend: audioStored.storageBackend,
    storageKey: audioStored.storageKey,
    publicUrl: audioStored.publicUrl,
    mimeType: audioStored.mimeType,
    sizeBytes: audioStored.sizeBytes,
    metadata: audioStored.metadata,
  });

  const prepared: PreparedMediaOutput = {
    sourceKind: "file",
    sourceVideoUrl: detail.sourceArtifact.publicUrl,
    sourceVideoPath,
    audioPath,
    audioMimeType: guessAudioMime(audioPath),
    workingDir,
    userPrompt: prompt,
  };
  await putAnalysisRunOutput(job.analysisRunId, OUTPUT_KEYS.preparedMedia, prepared);
  await queueTranscriptJobs(job.analysisRunId, prepared);
  await completeAnalysisJob(job.id, {
    sourceKind: prepared.sourceKind,
    workingDir,
  });
}

async function handleTranscribeAudioChunk(job: AnalysisJob) {
  const payload = job.payload as TranscribeAudioChunkPayload;
  const segments = await transcribeAudioChunk(payload);
  await putAnalysisRunOutput(job.analysisRunId, `transcript_chunk:${payload.chunkIndex}`, {
    chunkIndex: payload.chunkIndex,
    segments,
  });
  await completeAnalysisJob(job.id, {
    chunkIndex: payload.chunkIndex,
    segmentCount: segments.length,
  });
}

async function handleTranscribeVideoUrl(job: AnalysisJob) {
  const payload = job.payload as TranscribeVideoUrlPayload;
  const transcript = await transcribeVideoUrl({
    videoUrl: payload.videoUrl,
  });
  await putAnalysisRunOutput(job.analysisRunId, "transcript_chunk:0", {
    chunkIndex: 0,
    segments: transcript,
  });
  await completeAnalysisJob(job.id, {
    segmentCount: transcript.length,
  });
}

async function handleMergeTranscript(job: AnalysisJob) {
  await updateAnalysisRun(job.analysisRunId, {
    status: "processing",
    stage: "Merging transcript",
    error: null,
  });

  const chunkOutputs = await listAnalysisRunOutputsByPrefix<{
    chunkIndex: number;
    segments: TranscriptSegment[];
  }>(job.analysisRunId, "transcript_chunk:");
  const transcript = mergeTranscriptChunks(
    chunkOutputs.map((output) => ({
      chunkIndex: output.payload.chunkIndex,
      segments: output.payload.segments,
    })),
  );
  await putAnalysisRunOutput(job.analysisRunId, OUTPUT_KEYS.transcript, {
    transcript,
  });

  const run = await getAnalysisRun(job.analysisRunId);
  if (!run) {
    throw new Error("Analysis run not found");
  }

  await createAnalysisJob({
    analysisRunId: job.analysisRunId,
    jobType: run.mode === "analyze" ? "select_snapshots" : "analyze_moments",
  });
  await completeAnalysisJob(job.id, {
    transcriptSegments: transcript.length,
  });
}

async function handleAnalyzeMoments(job: AnalysisJob) {
  await updateAnalysisRun(job.analysisRunId, {
    status: "processing",
    stage: "Analyzing moments and flow",
    error: null,
  });

  const transcriptOutput = await getAnalysisRunOutput<TranscriptOutput>(
    job.analysisRunId,
    OUTPUT_KEYS.transcript,
  );
  if (!transcriptOutput) {
    throw new Error("Transcript is not available");
  }

  const { flowSteps, moments } = await analyzeMomentsAndFlow({
    transcript: transcriptOutput.transcript,
  });
  await putAnalysisRunOutput(job.analysisRunId, OUTPUT_KEYS.momentsFlow, {
    flowSteps,
    moments,
  });

  const limitedMoments = moments.slice(0, getMaxClipAnalyses());
  const dependencyIds: string[] = [];
  const clipPadSec = getClipPaddingSec();
  for (const [momentIndex, moment] of limitedMoments.entries()) {
    const clipStartSec = Math.max(0, moment.startSec - clipPadSec);
    const clipEndSec = moment.endSec + clipPadSec;
    const clipJobId = await createAnalysisJob({
      analysisRunId: job.analysisRunId,
      jobType: "analyze_clip",
      payload: {
        momentIndex,
        clipStartSec,
        clipEndSec,
        contextLabel: `${moment.category}-${momentIndex + 1}`,
      },
    });
    dependencyIds.push(clipJobId);
  }

  await createAnalysisJob({
    analysisRunId: job.analysisRunId,
    jobType: "merge_clip_findings",
    dependsOnJobIds: dependencyIds,
  });
  await completeAnalysisJob(job.id, {
    flowSteps: flowSteps.length,
    moments: moments.length,
  });
}

async function handleAnalyzeClip(job: AnalysisJob) {
  await updateAnalysisRun(job.analysisRunId, {
    status: "processing",
    stage: "Analyzing targeted clips",
    error: null,
  });

  const payload = job.payload as AnalyzeClipPayload;
  const transcriptOutput = await getAnalysisRunOutput<TranscriptOutput>(
    job.analysisRunId,
    OUTPUT_KEYS.transcript,
  );
  const prepared = await getAnalysisRunOutput<PreparedMediaOutput>(
    job.analysisRunId,
    OUTPUT_KEYS.preparedMedia,
  );

  if (!transcriptOutput || !prepared) {
    throw new Error("Clip analysis context is unavailable");
  }

  const transcriptExcerpt = transcriptExcerptForRange(
    transcriptOutput.transcript,
    payload.clipStartSec,
    payload.clipEndSec,
  );

  const finding =
    prepared.sourceKind === "youtube_url"
      ? await analyzeTargetClipFromVideoUrl({
          videoUrl: prepared.sourceVideoUrl,
          startSec: payload.clipStartSec,
          endSec: payload.clipEndSec,
          transcriptExcerpt,
          contextLabel: payload.contextLabel,
        })
      : await analyzeTargetClip({
          filePath: await extractVideoClip({
            videoPath: prepared.sourceVideoPath!,
            outputDir: prepared.workingDir!,
            startSec: payload.clipStartSec,
            endSec: payload.clipEndSec,
            filename: `target-clip-${String(payload.momentIndex).padStart(3, "0")}.mp4`,
          }),
          mimeType: "video/mp4",
          startSec: payload.clipStartSec,
          endSec: payload.clipEndSec,
          transcriptExcerpt,
          contextLabel: payload.contextLabel,
        });

  await putAnalysisRunOutput(
    job.analysisRunId,
    `clip_finding:${payload.momentIndex}`,
    {
      momentIndex: payload.momentIndex,
      finding,
    },
  );
  await completeAnalysisJob(job.id, {
    momentIndex: payload.momentIndex,
  });
}

async function handleMergeClipFindings(job: AnalysisJob) {
  await updateAnalysisRun(job.analysisRunId, {
    status: "processing",
    stage: "Merging clip findings",
    error: null,
  });

  const momentsFlow = await getAnalysisRunOutput<MomentsFlowOutput>(
    job.analysisRunId,
    OUTPUT_KEYS.momentsFlow,
  );
  if (!momentsFlow) {
    throw new Error("Moments and flow output is missing");
  }

  const clipOutputs = await listAnalysisRunOutputsByPrefix<ClipFindingOutput>(
    job.analysisRunId,
    "clip_finding:",
  );
  const clipFindings = clipOutputs
    .map((output) => output.payload)
    .sort((left, right) => left.momentIndex - right.momentIndex);
  const mergedMoments = mergeMomentsWithClipFindings({
    moments: momentsFlow.moments,
    clipFindings,
  });

  await putAnalysisRunOutput(job.analysisRunId, OUTPUT_KEYS.clipBundle, {
    flowSteps: momentsFlow.flowSteps,
    moments: mergedMoments,
    clipFindings: clipFindings.map((item) => item.finding),
  });
  await createAnalysisJob({
    analysisRunId: job.analysisRunId,
    jobType: "build_object_model",
  });
  await completeAnalysisJob(job.id, {
    clipFindings: clipFindings.length,
  });
}

async function handleBuildObjectModel(job: AnalysisJob) {
  await updateAnalysisRun(job.analysisRunId, {
    status: "processing",
    stage: "Building object model",
    error: null,
  });

  const transcript = await getAnalysisRunOutput<TranscriptOutput>(
    job.analysisRunId,
    OUTPUT_KEYS.transcript,
  );
  const clipBundle = await getAnalysisRunOutput<ClipBundleOutput>(
    job.analysisRunId,
    OUTPUT_KEYS.clipBundle,
  );

  if (!transcript || !clipBundle) {
    throw new Error("Object model inputs are unavailable");
  }

  const objectModel = await buildObjectModel({
    transcript: transcript.transcript,
    clipFindings: clipBundle.clipFindings,
  });
  await putAnalysisRunOutput(job.analysisRunId, OUTPUT_KEYS.objectModel, objectModel);
  await createAnalysisJob({
    analysisRunId: job.analysisRunId,
    jobType: "finalize_run",
  });
  await completeAnalysisJob(job.id, {
    entities: objectModel.entities.length,
    relationships: objectModel.relationships.length,
  });
}

async function handleSelectSnapshots(job: AnalysisJob) {
  await updateAnalysisRun(job.analysisRunId, {
    status: "processing",
    stage: "Selecting snapshots",
    error: null,
  });

  const transcript = await getAnalysisRunOutput<TranscriptOutput>(
    job.analysisRunId,
    OUTPUT_KEYS.transcript,
  );
  const prepared = await getAnalysisRunOutput<PreparedMediaOutput>(
    job.analysisRunId,
    OUTPUT_KEYS.preparedMedia,
  );
  const run = await getAnalysisRun(job.analysisRunId);
  if (!transcript || !prepared || !run) {
    throw new Error("Snapshot selection inputs are unavailable");
  }

  const selection = await selectInterestingSnapshots({
    transcript: transcript.transcript,
    userPrompt: prepared.userPrompt ?? run.prompt ?? defaultAnalyzePrompt(),
  });
  const candidates = selection.snapshots.slice(0, getMaxPromptedSnapshots()).map(
    (candidate, index) => ({
      ...candidate,
      index,
    }),
  );
  await putAnalysisRunOutput(job.analysisRunId, OUTPUT_KEYS.snapshotSelection, {
    summary: selection.summary,
    candidates,
  });

  const dependencyIds: string[] = [];
  for (const candidate of candidates) {
    const dependencyId = await createAnalysisJob({
      analysisRunId: job.analysisRunId,
      jobType: "analyze_snapshot",
      payload: {
        snapshotIndex: candidate.index,
        candidate: {
          timestampSec: candidate.timestampSec,
          title: candidate.title,
          rationale: candidate.rationale,
          transcriptEvidence: candidate.transcriptEvidence,
        },
      },
    });
    dependencyIds.push(dependencyId);
  }

  await createAnalysisJob({
    analysisRunId: job.analysisRunId,
    jobType: "merge_snapshots",
    dependsOnJobIds: dependencyIds,
  });
  await completeAnalysisJob(job.id, {
    snapshots: candidates.length,
  });
}

async function handleAnalyzeSnapshot(job: AnalysisJob) {
  await updateAnalysisRun(job.analysisRunId, {
    status: "processing",
    stage: "Analyzing snapshots",
    error: null,
  });

  const payload = job.payload as AnalyzeSnapshotPayload;
  const transcript = await getAnalysisRunOutput<TranscriptOutput>(
    job.analysisRunId,
    OUTPUT_KEYS.transcript,
  );
  const prepared = await getAnalysisRunOutput<PreparedMediaOutput>(
    job.analysisRunId,
    OUTPUT_KEYS.preparedMedia,
  );
  if (!transcript || !prepared) {
    throw new Error("Snapshot analysis context is unavailable");
  }

  const snapshot =
    prepared.sourceKind === "youtube_url"
      ? await analyzePromptedSnapshotFromVideoUrl({
          videoUrl: prepared.sourceVideoUrl,
          transcript: transcript.transcript,
          candidate: payload.candidate,
          index: payload.snapshotIndex,
        })
      : await analyzePromptedSnapshotFromFile({
          sourceVideoPath: prepared.sourceVideoPath!,
          workingDir: prepared.workingDir!,
          transcript: transcript.transcript,
          userPrompt: prepared.userPrompt ?? defaultAnalyzePrompt(),
          candidate: payload.candidate,
          index: payload.snapshotIndex,
        });

  await putAnalysisRunOutput(
    job.analysisRunId,
    `snapshot:${payload.snapshotIndex}`,
    {
      snapshotIndex: payload.snapshotIndex,
      snapshot,
    },
  );
  await completeAnalysisJob(job.id, {
    snapshotIndex: payload.snapshotIndex,
  });
}

async function handleMergeSnapshots(job: AnalysisJob) {
  await updateAnalysisRun(job.analysisRunId, {
    status: "processing",
    stage: "Merging snapshot notes",
    error: null,
  });

  const selection = await getAnalysisRunOutput<SnapshotSelectionOutput>(
    job.analysisRunId,
    OUTPUT_KEYS.snapshotSelection,
  );
  if (!selection) {
    throw new Error("Snapshot selection output is missing");
  }

  const snapshots = (
    await listAnalysisRunOutputsByPrefix<SnapshotOutput>(job.analysisRunId, "snapshot:")
  )
    .map((output) => output.payload)
    .sort((left, right) => left.snapshotIndex - right.snapshotIndex)
    .map((output) => output.snapshot);

  await putAnalysisRunOutput(job.analysisRunId, OUTPUT_KEYS.snapshotRun, {
    summary: selection.summary,
    snapshots,
  });
  await createAnalysisJob({
    analysisRunId: job.analysisRunId,
    jobType: "finalize_run",
  });
  await completeAnalysisJob(job.id, {
    snapshots: snapshots.length,
  });
}

async function handleFinalizeRun(job: AnalysisJob) {
  await updateAnalysisRun(job.analysisRunId, {
    status: "processing",
    stage: "Persisting memory and reports",
    error: null,
  });

  const run = await getAnalysisRun(job.analysisRunId);
  if (!run) {
    throw new Error("Analysis run not found");
  }

  const transcript = await getAnalysisRunOutput<TranscriptOutput>(
    job.analysisRunId,
    OUTPUT_KEYS.transcript,
  );
  const detail = await getVideoDetail(run.videoId);
  if (!transcript || !detail) {
    throw new Error("Finalize inputs are unavailable");
  }

  let analysis: AnalysisResult;
  let screenshotImagePaths: Array<string | null> = [];

  if (run.mode === "pm_report") {
    const clipBundle = await getAnalysisRunOutput<ClipBundleOutput>(
      job.analysisRunId,
      OUTPUT_KEYS.clipBundle,
    );
    const objectModel = await getAnalysisRunOutput<ObjectModelOutput>(
      job.analysisRunId,
      OUTPUT_KEYS.objectModel,
    );
    if (!clipBundle || !objectModel) {
      throw new Error("PM report outputs are incomplete");
    }

    const builtReports = buildReports({
      transcript: transcript.transcript,
      flowSteps: clipBundle.flowSteps,
      screenshots: [],
      moments: clipBundle.moments,
      entities: objectModel.entities,
      relationships: objectModel.relationships,
    });

    analysis = {
      transcript: transcript.transcript,
      screenshots: [],
      flowSteps: clipBundle.flowSteps,
      moments: clipBundle.moments,
      entities: objectModel.entities,
      relationships: objectModel.relationships,
      reports: builtReports,
    };
  } else {
    const snapshotRun = await getAnalysisRunOutput<SnapshotRunOutput>(
      job.analysisRunId,
      OUTPUT_KEYS.snapshotRun,
    );
    if (!snapshotRun) {
      throw new Error("Snapshot outputs are incomplete");
    }

    analysis = {
      transcript: transcript.transcript,
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
            (snapshot) => `${snapshot.timestampSec.toFixed(1)}s: ${snapshot.caption}`,
          ),
        },
      },
    };
    screenshotImagePaths = snapshotRun.snapshots.map(
      (snapshot) => snapshot.imagePath ?? null,
    );
  }

  const analysisWithArtifacts = await attachScreenshotArtifacts({
    videoId: run.videoId,
    runId: job.analysisRunId,
    analysis,
    screenshotImagePaths,
  });

  await persistAnalysis(job.analysisRunId, analysisWithArtifacts, {
    bugReport: renderBugReportHtml(analysisWithArtifacts.reports.bugReport),
    objectModelReport: renderObjectModelReportHtml(
      analysisWithArtifacts.reports.objectModelReport,
    ),
    timelineReport: renderTimelineReportHtml(analysisWithArtifacts.reports.timelineReport),
  });
  await updateAnalysisRun(job.analysisRunId, {
    status: "completed",
    stage: "Completed",
    error: null,
    completed: true,
  });
  await updateVideoStatus(run.videoId, "ready");
  await cleanupRunFiles(job.analysisRunId);
  await completeAnalysisJob(job.id, {
    transcriptSegments: analysisWithArtifacts.transcript.length,
  });
}

export async function markAnalysisRunFailed(
  job: AnalysisJob,
  message: string,
) {
  await updateAnalysisRun(job.analysisRunId, {
    status: "failed",
    stage: "Failed",
    error: message,
  }).catch(() => {});
  const run = await getAnalysisRun(job.analysisRunId).catch(() => null);
  if (run) {
    await updateVideoStatus(run.videoId, "failed").catch(() => {});
  }
  await cancelQueuedAnalysisJobsForRun(job.analysisRunId, {
    exceptJobId: job.id,
  }).catch(() => {});
  await cleanupRunFiles(job.analysisRunId).catch(() => {});
}

export async function processAnalysisJob(job: AnalysisJob) {
  switch (job.jobType) {
    case "prepare_media":
      await handlePrepareMedia(job);
      break;
    case "transcribe_audio_chunk":
      await handleTranscribeAudioChunk(job);
      break;
    case "transcribe_video_url":
      await handleTranscribeVideoUrl(job);
      break;
    case "merge_transcript":
      await handleMergeTranscript(job);
      break;
    case "analyze_moments":
      await handleAnalyzeMoments(job);
      break;
    case "analyze_clip":
      await handleAnalyzeClip(job);
      break;
    case "merge_clip_findings":
      await handleMergeClipFindings(job);
      break;
    case "build_object_model":
      await handleBuildObjectModel(job);
      break;
    case "select_snapshots":
      await handleSelectSnapshots(job);
      break;
    case "analyze_snapshot":
      await handleAnalyzeSnapshot(job);
      break;
    case "merge_snapshots":
      await handleMergeSnapshots(job);
      break;
    case "finalize_run":
      await handleFinalizeRun(job);
      break;
    default: {
      const exhaustiveCheck: never = job.jobType;
      throw new Error(`Unhandled analysis job type: ${exhaustiveCheck}`);
    }
  }
}
