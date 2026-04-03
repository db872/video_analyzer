import {
  claimNextAnalysisJobOfType,
  failAnalysisJob,
} from "@/lib/server/db";
import {
  getAnalysisJobMaxAttempts,
  getAnalysisJobRetryDelaySec,
  markAnalysisRunFailed,
  processAnalysisJob,
} from "@/lib/server/analysis-pipeline";
import type { AnalysisJob, AnalysisJobType } from "@/lib/types";

type WorkerState = {
  started: boolean;
  activeJobs: Map<string, AnalysisJob>;
  wakeRequested: boolean;
};

declare global {
  var __pmVideoAnalysisWorker: WorkerState | undefined;
}

const CLAIM_ORDER: AnalysisJobType[] = [
  "finalize_run",
  "merge_snapshots",
  "build_object_model",
  "merge_clip_findings",
  "select_snapshots",
  "analyze_moments",
  "merge_transcript",
  "prepare_media",
  "analyze_snapshot",
  "analyze_clip",
  "transcribe_video_url",
  "transcribe_audio_chunk",
];

function getWorkerState() {
  if (!globalThis.__pmVideoAnalysisWorker) {
    globalThis.__pmVideoAnalysisWorker = {
      started: false,
      activeJobs: new Map(),
      wakeRequested: false,
    };
  }
  return globalThis.__pmVideoAnalysisWorker;
}

function getTotalConcurrency() {
  const value = Number(process.env.ANALYSIS_WORKER_CONCURRENCY ?? "4");
  return Number.isFinite(value) && value > 0 ? value : 4;
}

function getJobTypeConcurrencyLimit(jobType: AnalysisJobType) {
  const envValue =
    jobType === "transcribe_audio_chunk" || jobType === "transcribe_video_url"
      ? process.env.ANALYSIS_TRANSCRIBE_CONCURRENCY
      : jobType === "analyze_clip"
        ? process.env.ANALYSIS_CLIP_CONCURRENCY
        : jobType === "analyze_snapshot"
          ? process.env.ANALYSIS_SNAPSHOT_CONCURRENCY
          : undefined;

  if (!envValue) {
    if (jobType === "analyze_clip") return 2;
    if (jobType === "analyze_snapshot") return 3;
    if (jobType === "transcribe_audio_chunk" || jobType === "transcribe_video_url") {
      return 3;
    }
    return getTotalConcurrency();
  }

  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : getTotalConcurrency();
}

function activeCountForType(
  state: WorkerState,
  jobType: AnalysisJobType,
) {
  let count = 0;
  for (const activeJob of state.activeJobs.values()) {
    if (activeJob.jobType === jobType) {
      count += 1;
    }
  }
  return count;
}

async function claimNextRunnableJob(state: WorkerState) {
  for (const jobType of CLAIM_ORDER) {
    if (activeCountForType(state, jobType) >= getJobTypeConcurrencyLimit(jobType)) {
      continue;
    }

    const claimedJob = await claimNextAnalysisJobOfType(jobType);
    if (claimedJob) {
      return claimedJob;
    }
  }

  return null;
}

async function executeJob(state: WorkerState, job: AnalysisJob) {
  state.activeJobs.set(job.id, job);

  try {
    await processAnalysisJob(job);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Analysis job failed";
    const maxAttempts = getAnalysisJobMaxAttempts(job);
    const retryable = job.attemptCount < maxAttempts;

    await failAnalysisJob(job.id, {
      error: message,
      retryable,
      retryDelaySec: getAnalysisJobRetryDelaySec(job),
    });

    if (!retryable) {
      await markAnalysisRunFailed(job, message);
    }
  } finally {
    state.activeJobs.delete(job.id);
    state.wakeRequested = true;
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function workerLoop(state: WorkerState) {
  while (state.started) {
    while (state.activeJobs.size < getTotalConcurrency()) {
      const nextJob = await claimNextRunnableJob(state);
      if (!nextJob) {
        break;
      }

      state.wakeRequested = false;
      void executeJob(state, nextJob);
    }

    if (state.wakeRequested) {
      state.wakeRequested = false;
      continue;
    }

    await sleep(state.activeJobs.size > 0 ? 250 : 1000);
  }
}

export function ensureAnalysisWorkerRunning() {
  const state = getWorkerState();
  state.wakeRequested = true;

  if (state.started) {
    return;
  }

  state.started = true;
  void workerLoop(state).catch((error) => {
    console.error("[analysis-worker] worker loop crashed", error);
    state.started = false;
  });
}
