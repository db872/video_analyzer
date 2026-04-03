import { randomUUID } from "crypto";
import { neon } from "@neondatabase/serverless";
import type {
  AnalysisJob,
  AnalysisJobStatus,
  AnalysisJobType,
  AnalysisMode,
  AnalysisResult,
  AnalysisRun,
  BugReport,
  FlowStep,
  MemoryEntity,
  MemoryRelationship,
  Moment,
  ObjectModelReport,
  ScreenshotInsight,
  StoredArtifact,
  TimelineReport,
  TranscriptSegment,
  VideoDetail,
  VideoListItem,
  VideoStatus,
} from "@/lib/types";

type JsonRecord = Record<string, unknown>;

type SqlClient = ReturnType<typeof neon>;

let sqlClient: SqlClient | null = null;
let schemaReady: Promise<void> | null = null;

function getSql() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not configured. Add a Neon Postgres connection string to enable persistence.",
    );
  }

  if (!sqlClient) {
    sqlClient = neon(databaseUrl);
  }

  return sqlClient;
}

function asJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function toIso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toNumber(value: unknown, fallback = 0) {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asRows(value: unknown) {
  return value as Array<Record<string, unknown>>;
}

function mapArtifact(row: Record<string, unknown>, prefix = ""): StoredArtifact {
  return {
    id: String(row[`${prefix}artifact_id`]),
    kind: String(row[`${prefix}artifact_kind`]) as StoredArtifact["kind"],
    storageBackend: String(
      row[`${prefix}artifact_storage_backend`],
    ) as StoredArtifact["storageBackend"],
    storageKey: String(row[`${prefix}artifact_storage_key`]),
    publicUrl: String(row[`${prefix}artifact_public_url`]),
    mimeType: String(row[`${prefix}artifact_mime_type`]),
    sizeBytes: toNumber(row[`${prefix}artifact_size_bytes`]),
    metadata: asJson<Record<string, unknown>>(
      row[`${prefix}artifact_metadata`],
      {},
    ),
    createdAt: toIso(row[`${prefix}artifact_created_at`]),
  };
}

function mapRun(row: Record<string, unknown>, prefix = ""): AnalysisRun | null {
  if (!row[`${prefix}run_id`]) return null;
  return {
    id: String(row[`${prefix}run_id`]),
    videoId: String(row[`${prefix}run_video_id`]),
    status: String(row[`${prefix}run_status`]) as AnalysisRun["status"],
    mode: String(row[`${prefix}run_mode`] ?? "pm_report") as AnalysisRun["mode"],
    prompt:
      row[`${prefix}run_prompt`] == null ? null : String(row[`${prefix}run_prompt`]),
    stage: String(row[`${prefix}run_stage`] ?? ""),
    error:
      row[`${prefix}run_error`] == null
        ? null
        : String(row[`${prefix}run_error`]),
    configVersion: String(row[`${prefix}run_config_version`]),
    createdAt: toIso(row[`${prefix}run_created_at`]),
    updatedAt: toIso(row[`${prefix}run_updated_at`]),
    completedAt:
      row[`${prefix}run_completed_at`] == null
        ? null
        : toIso(row[`${prefix}run_completed_at`]),
    progress: {
      totalJobs: toNumber(row[`${prefix}run_total_jobs`]),
      queuedJobs: toNumber(row[`${prefix}run_queued_jobs`]),
      processingJobs: toNumber(row[`${prefix}run_processing_jobs`]),
      completedJobs: toNumber(row[`${prefix}run_completed_jobs`]),
      failedJobs: toNumber(row[`${prefix}run_failed_jobs`]),
      cancelledJobs: toNumber(row[`${prefix}run_cancelled_jobs`]),
      transcriptionTotal: toNumber(row[`${prefix}run_transcription_total`]),
      transcriptionCompleted: toNumber(row[`${prefix}run_transcription_completed`]),
      clipTotal: toNumber(row[`${prefix}run_clip_total`]),
      clipCompleted: toNumber(row[`${prefix}run_clip_completed`]),
      snapshotTotal: toNumber(row[`${prefix}run_snapshot_total`]),
      snapshotCompleted: toNumber(row[`${prefix}run_snapshot_completed`]),
    },
  };
}

function mapJob(row: Record<string, unknown>): AnalysisJob {
  return {
    id: String(row.id),
    analysisRunId: String(row.analysis_run_id),
    jobType: String(row.job_type) as AnalysisJobType,
    status: String(row.status) as AnalysisJobStatus,
    payload: asJson<JsonRecord>(row.payload_json, {}),
    result: row.result_json == null ? null : asJson<JsonRecord>(row.result_json, {}),
    error: row.error == null ? null : String(row.error),
    attemptCount: toNumber(row.attempt_count),
    priority: toNumber(row.priority),
    availableAt: toIso(row.available_at),
    startedAt: row.started_at == null ? null : toIso(row.started_at),
    completedAt: row.completed_at == null ? null : toIso(row.completed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS videos (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'uploaded',
          source_artifact_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS analysis_runs (
          id TEXT PRIMARY KEY,
          video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'pm_report',
          prompt TEXT,
          stage TEXT NOT NULL,
          error TEXT,
          config_version TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        )
      `;

      await sql`
        ALTER TABLE analysis_runs
        ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'pm_report'
      `;

      await sql`
        ALTER TABLE analysis_runs
        ADD COLUMN IF NOT EXISTS prompt TEXT
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS analysis_jobs (
          id TEXT PRIMARY KEY,
          analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
          job_type TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          result_json JSONB,
          error TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          priority INTEGER NOT NULL DEFAULT 0,
          available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS analysis_job_dependencies (
          job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
          depends_on_job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
          PRIMARY KEY (job_id, depends_on_job_id)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS analysis_run_outputs (
          analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
          output_key TEXT NOT NULL,
          payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (analysis_run_id, output_key)
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
          analysis_run_id TEXT REFERENCES analysis_runs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          storage_backend TEXT NOT NULL,
          storage_key TEXT NOT NULL,
          public_url TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes BIGINT NOT NULL DEFAULT 0,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS transcript_segments (
          id TEXT PRIMARY KEY,
          analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
          segment_index INTEGER NOT NULL,
          start_sec DOUBLE PRECISION NOT NULL,
          end_sec DOUBLE PRECISION NOT NULL,
          text TEXT NOT NULL
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS screenshot_frames (
          id TEXT PRIMARY KEY,
          analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
          artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
          frame_index INTEGER NOT NULL,
          timestamp_sec DOUBLE PRECISION NOT NULL,
          page_label TEXT,
          caption TEXT NOT NULL,
          raw_notes TEXT,
          objects JSONB NOT NULL DEFAULT '[]'::jsonb
        )
      `;

      await sql`
        ALTER TABLE screenshot_frames
        ALTER COLUMN artifact_id DROP NOT NULL
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS flow_steps (
          id TEXT PRIMARY KEY,
          analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
          step_index INTEGER NOT NULL,
          start_sec DOUBLE PRECISION NOT NULL,
          end_sec DOUBLE PRECISION NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          user_goal TEXT NOT NULL
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS moments (
          id TEXT PRIMARY KEY,
          analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
          start_sec DOUBLE PRECISION NOT NULL,
          end_sec DOUBLE PRECISION NOT NULL,
          category TEXT NOT NULL,
          severity TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          quote TEXT,
          evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
          suggested_ticket_title TEXT,
          acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS memory_entities (
          id TEXT PRIMARY KEY,
          analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
          entity_type TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          confidence DOUBLE PRECISION NOT NULL,
          first_seen_sec DOUBLE PRECISION,
          last_seen_sec DOUBLE PRECISION,
          source_evidence JSONB NOT NULL DEFAULT '[]'::jsonb
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS memory_relationships (
          id TEXT PRIMARY KEY,
          analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
          from_entity TEXT NOT NULL,
          to_entity TEXT NOT NULL,
          relationship_type TEXT NOT NULL,
          description TEXT NOT NULL,
          confidence DOUBLE PRECISION NOT NULL
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS reports (
          id TEXT PRIMARY KEY,
          analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
          report_type TEXT NOT NULL,
          content JSONB NOT NULL,
          html TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      await sql`
        CREATE INDEX IF NOT EXISTS analysis_runs_video_idx
        ON analysis_runs (video_id, created_at DESC)
      `;

      await sql`
        CREATE INDEX IF NOT EXISTS analysis_jobs_run_idx
        ON analysis_jobs (analysis_run_id, created_at ASC)
      `;

      await sql`
        CREATE INDEX IF NOT EXISTS analysis_jobs_status_idx
        ON analysis_jobs (status, available_at, priority DESC, created_at ASC)
      `;

      await sql`
        CREATE INDEX IF NOT EXISTS analysis_jobs_type_status_idx
        ON analysis_jobs (job_type, status, available_at, created_at ASC)
      `;

      await sql`
        CREATE INDEX IF NOT EXISTS analysis_job_dependencies_dep_idx
        ON analysis_job_dependencies (depends_on_job_id)
      `;

      await sql`
        CREATE INDEX IF NOT EXISTS analysis_run_outputs_run_idx
        ON analysis_run_outputs (analysis_run_id, output_key)
      `;

      await sql`
        CREATE INDEX IF NOT EXISTS artifacts_video_idx
        ON artifacts (video_id, created_at DESC)
      `;

      await sql`
        CREATE INDEX IF NOT EXISTS transcript_segments_run_idx
        ON transcript_segments (analysis_run_id, segment_index)
      `;

      await sql`
        CREATE INDEX IF NOT EXISTS screenshot_frames_run_idx
        ON screenshot_frames (analysis_run_id, frame_index)
      `;

      await sql`
        CREATE INDEX IF NOT EXISTS moments_run_idx
        ON moments (analysis_run_id, start_sec)
      `;
    })();
  }

  await schemaReady;
}

export async function createVideo(params: {
  title: string;
  status?: VideoStatus;
}) {
  await ensureSchema();
  const sql = getSql();
  const id = randomUUID();
  const status = params.status ?? "uploaded";

  await sql`
    INSERT INTO videos (id, title, status)
    VALUES (${id}, ${params.title}, ${status})
  `;

  return id;
}

export async function attachSourceArtifact(videoId: string, artifactId: string) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    UPDATE videos
    SET source_artifact_id = ${artifactId}, updated_at = NOW()
    WHERE id = ${videoId}
  `;
}

export async function updateVideoStatus(videoId: string, status: VideoStatus) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    UPDATE videos
    SET status = ${status}, updated_at = NOW()
    WHERE id = ${videoId}
  `;
}

export async function insertArtifact(params: {
  videoId: string;
  analysisRunId?: string | null;
  kind: StoredArtifact["kind"];
  storageBackend: StoredArtifact["storageBackend"];
  storageKey: string;
  publicUrl: string;
  mimeType: string;
  sizeBytes: number;
  metadata?: Record<string, unknown>;
}) {
  await ensureSchema();
  const sql = getSql();
  const id = randomUUID();

  await sql`
    INSERT INTO artifacts (
      id,
      video_id,
      analysis_run_id,
      kind,
      storage_backend,
      storage_key,
      public_url,
      mime_type,
      size_bytes,
      metadata
    )
    VALUES (
      ${id},
      ${params.videoId},
      ${params.analysisRunId ?? null},
      ${params.kind},
      ${params.storageBackend},
      ${params.storageKey},
      ${params.publicUrl},
      ${params.mimeType},
      ${params.sizeBytes},
      ${JSON.stringify(params.metadata ?? {})}::jsonb
    )
  `;

  const rows = asRows(await sql`
    SELECT
      id AS artifact_id,
      kind AS artifact_kind,
      storage_backend AS artifact_storage_backend,
      storage_key AS artifact_storage_key,
      public_url AS artifact_public_url,
      mime_type AS artifact_mime_type,
      size_bytes AS artifact_size_bytes,
      metadata AS artifact_metadata,
      created_at AS artifact_created_at
    FROM artifacts
    WHERE id = ${id}
  `);

  return mapArtifact(rows[0]);
}

export async function getArtifact(artifactId: string) {
  await ensureSchema();
  const sql = getSql();
  const rows = asRows(await sql`
    SELECT
      id AS artifact_id,
      kind AS artifact_kind,
      storage_backend AS artifact_storage_backend,
      storage_key AS artifact_storage_key,
      public_url AS artifact_public_url,
      mime_type AS artifact_mime_type,
      size_bytes AS artifact_size_bytes,
      metadata AS artifact_metadata,
      created_at AS artifact_created_at
    FROM artifacts
    WHERE id = ${artifactId}
  `);

  if (rows.length === 0) return null;
  return mapArtifact(rows[0]);
}

export async function listArtifactsForVideo(videoId: string) {
  await ensureSchema();
  const sql = getSql();
  const rows = asRows(await sql`
    SELECT
      id AS artifact_id,
      kind AS artifact_kind,
      storage_backend AS artifact_storage_backend,
      storage_key AS artifact_storage_key,
      public_url AS artifact_public_url,
      mime_type AS artifact_mime_type,
      size_bytes AS artifact_size_bytes,
      metadata AS artifact_metadata,
      created_at AS artifact_created_at
    FROM artifacts
    WHERE video_id = ${videoId}
    ORDER BY created_at DESC
  `);

  return rows.map((row) => mapArtifact(row));
}

export async function getAnalysisRun(runId: string) {
  await ensureSchema();
  const sql = getSql();
  const rows = asRows(await sql`
    SELECT
      r.id AS run_id,
      r.video_id AS run_video_id,
      r.status AS run_status,
      r.mode AS run_mode,
      r.prompt AS run_prompt,
      r.stage AS run_stage,
      r.error AS run_error,
      r.config_version AS run_config_version,
      r.created_at AS run_created_at,
      r.updated_at AS run_updated_at,
      r.completed_at AS run_completed_at,
      COALESCE(stats.total_jobs, 0) AS run_total_jobs,
      COALESCE(stats.queued_jobs, 0) AS run_queued_jobs,
      COALESCE(stats.processing_jobs, 0) AS run_processing_jobs,
      COALESCE(stats.completed_jobs, 0) AS run_completed_jobs,
      COALESCE(stats.failed_jobs, 0) AS run_failed_jobs,
      COALESCE(stats.cancelled_jobs, 0) AS run_cancelled_jobs,
      COALESCE(stats.transcription_total, 0) AS run_transcription_total,
      COALESCE(stats.transcription_completed, 0) AS run_transcription_completed,
      COALESCE(stats.clip_total, 0) AS run_clip_total,
      COALESCE(stats.clip_completed, 0) AS run_clip_completed,
      COALESCE(stats.snapshot_total, 0) AS run_snapshot_total,
      COALESCE(stats.snapshot_completed, 0) AS run_snapshot_completed
    FROM analysis_runs r
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS total_jobs,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued_jobs,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing_jobs,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed_jobs,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed_jobs,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_jobs,
        COUNT(*) FILTER (WHERE job_type IN ('transcribe_audio_chunk', 'transcribe_video_url'))
          AS transcription_total,
        COUNT(*) FILTER (
          WHERE job_type IN ('transcribe_audio_chunk', 'transcribe_video_url')
            AND status = 'completed'
        ) AS transcription_completed,
        COUNT(*) FILTER (WHERE job_type = 'analyze_clip') AS clip_total,
        COUNT(*) FILTER (
          WHERE job_type = 'analyze_clip'
            AND status = 'completed'
        ) AS clip_completed,
        COUNT(*) FILTER (WHERE job_type = 'analyze_snapshot') AS snapshot_total,
        COUNT(*) FILTER (
          WHERE job_type = 'analyze_snapshot'
            AND status = 'completed'
        ) AS snapshot_completed
      FROM analysis_jobs
      WHERE analysis_run_id = r.id
    ) stats ON TRUE
    WHERE r.id = ${runId}
  `);
  if (rows.length === 0) return null;
  return mapRun(rows[0]);
}

export async function deleteVideo(videoId: string) {
  await ensureSchema();
  const sql = getSql();
  await sql`DELETE FROM videos WHERE id = ${videoId}`;
}

export async function createAnalysisRun(params: {
  videoId: string;
  configVersion: string;
  mode?: AnalysisMode;
  prompt?: string | null;
}) {
  await ensureSchema();
  const sql = getSql();
  const id = randomUUID();
  await sql`
    INSERT INTO analysis_runs (id, video_id, status, mode, prompt, stage, config_version)
    VALUES (
      ${id},
      ${params.videoId},
      'queued',
      ${params.mode ?? "pm_report"},
      ${params.prompt ?? null},
      'queued',
      ${params.configVersion}
    )
  `;
  return id;
}

export async function updateAnalysisRun(
  runId: string,
  params: {
    status?: AnalysisRun["status"];
    stage?: string;
    error?: string | null;
    completed?: boolean;
  },
) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    UPDATE analysis_runs
    SET
      status = COALESCE(${params.status ?? null}, status),
      stage = COALESCE(${params.stage ?? null}, stage),
      error = ${params.error ?? null},
      updated_at = NOW(),
      completed_at = CASE
        WHEN ${params.completed ?? false} THEN NOW()
        ELSE completed_at
      END
    WHERE id = ${runId}
  `;
}

export async function createAnalysisJob(params: {
  analysisRunId: string;
  jobType: AnalysisJobType;
  payload?: JsonRecord;
  priority?: number;
  availableAt?: Date | string;
  dependsOnJobIds?: string[];
}) {
  await ensureSchema();
  const sql = getSql();
  const id = randomUUID();

  await sql`
    INSERT INTO analysis_jobs (
      id,
      analysis_run_id,
      job_type,
      status,
      payload_json,
      priority,
      available_at
    )
    VALUES (
      ${id},
      ${params.analysisRunId},
      ${params.jobType},
      'queued',
      ${JSON.stringify(params.payload ?? {})}::jsonb,
      ${params.priority ?? 0},
      ${params.availableAt ?? new Date().toISOString()}
    )
  `;

  for (const dependencyId of params.dependsOnJobIds ?? []) {
    await sql`
      INSERT INTO analysis_job_dependencies (job_id, depends_on_job_id)
      VALUES (${id}, ${dependencyId})
      ON CONFLICT DO NOTHING
    `;
  }

  return id;
}

export async function claimNextAnalysisJobOfType(jobType: AnalysisJobType) {
  await ensureSchema();
  const sql = getSql();
  const rows = asRows(await sql`
    WITH next_job AS (
      SELECT aj.id
      FROM analysis_jobs aj
      WHERE aj.job_type = ${jobType}
        AND aj.status = 'queued'
        AND aj.available_at <= NOW()
        AND NOT EXISTS (
          SELECT 1
          FROM analysis_job_dependencies ajd
          JOIN analysis_jobs dep
            ON dep.id = ajd.depends_on_job_id
          WHERE ajd.job_id = aj.id
            AND dep.status <> 'completed'
        )
      ORDER BY aj.priority DESC, aj.created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE analysis_jobs aj
    SET
      status = 'processing',
      started_at = NOW(),
      updated_at = NOW(),
      attempt_count = attempt_count + 1,
      error = NULL
    FROM next_job
    WHERE aj.id = next_job.id
    RETURNING aj.*
  `);

  if (rows.length === 0) return null;
  return mapJob(rows[0]);
}

export async function completeAnalysisJob(
  jobId: string,
  result?: JsonRecord | null,
) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    UPDATE analysis_jobs
    SET
      status = 'completed',
      result_json = ${result == null ? null : JSON.stringify(result)}::jsonb,
      error = NULL,
      completed_at = NOW(),
      updated_at = NOW()
    WHERE id = ${jobId}
  `;
}

export async function failAnalysisJob(
  jobId: string,
  params: {
    error: string;
    retryable?: boolean;
    retryDelaySec?: number;
    result?: JsonRecord | null;
  },
) {
  await ensureSchema();
  const sql = getSql();

  if (params.retryable) {
    await sql`
      UPDATE analysis_jobs
      SET
        status = 'queued',
        error = ${params.error},
        result_json = ${params.result == null ? null : JSON.stringify(params.result)}::jsonb,
        available_at = NOW() + (${params.retryDelaySec ?? 15} * INTERVAL '1 second'),
        started_at = NULL,
        updated_at = NOW()
      WHERE id = ${jobId}
    `;
    return;
  }

  await sql`
    UPDATE analysis_jobs
    SET
      status = 'failed',
      error = ${params.error},
      result_json = ${params.result == null ? null : JSON.stringify(params.result)}::jsonb,
      completed_at = NOW(),
      updated_at = NOW()
    WHERE id = ${jobId}
  `;
}

export async function cancelQueuedAnalysisJobsForRun(
  runId: string,
  options?: { exceptJobId?: string },
) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    UPDATE analysis_jobs
    SET
      status = 'cancelled',
      completed_at = NOW(),
      updated_at = NOW()
    WHERE analysis_run_id = ${runId}
      AND status = 'queued'
      AND (${options?.exceptJobId ?? null} IS NULL OR id <> ${options?.exceptJobId ?? null})
  `;
}

export async function getAnalysisJob(jobId: string) {
  await ensureSchema();
  const sql = getSql();
  const rows = asRows(await sql`
    SELECT *
    FROM analysis_jobs
    WHERE id = ${jobId}
  `);
  if (rows.length === 0) return null;
  return mapJob(rows[0]);
}

export async function listAnalysisJobsForRun(runId: string) {
  await ensureSchema();
  const sql = getSql();
  const rows = asRows(await sql`
    SELECT *
    FROM analysis_jobs
    WHERE analysis_run_id = ${runId}
    ORDER BY created_at ASC
  `);
  return rows.map(mapJob);
}

export async function putAnalysisRunOutput(
  runId: string,
  outputKey: string,
  payload: JsonRecord,
) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    INSERT INTO analysis_run_outputs (
      analysis_run_id,
      output_key,
      payload_json
    )
    VALUES (
      ${runId},
      ${outputKey},
      ${JSON.stringify(payload)}::jsonb
    )
    ON CONFLICT (analysis_run_id, output_key)
    DO UPDATE SET
      payload_json = EXCLUDED.payload_json,
      updated_at = NOW()
  `;
}

export async function getAnalysisRunOutput<T extends JsonRecord>(
  runId: string,
  outputKey: string,
) {
  await ensureSchema();
  const sql = getSql();
  const rows = asRows(await sql`
    SELECT payload_json
    FROM analysis_run_outputs
    WHERE analysis_run_id = ${runId}
      AND output_key = ${outputKey}
  `);
  if (rows.length === 0) return null;
  return asJson<T>(rows[0].payload_json, {} as T);
}

export async function listAnalysisRunOutputsByPrefix<T extends JsonRecord>(
  runId: string,
  prefix: string,
) {
  await ensureSchema();
  const sql = getSql();
  const rows = asRows(await sql`
    SELECT output_key, payload_json
    FROM analysis_run_outputs
    WHERE analysis_run_id = ${runId}
      AND output_key LIKE ${`${prefix}%`}
    ORDER BY output_key ASC
  `);

  return rows.map((row) => ({
    outputKey: String(row.output_key),
    payload: asJson<T>(row.payload_json, {} as T),
  }));
}

export async function deleteAnalysisRunOutputPrefix(runId: string, prefix: string) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    DELETE FROM analysis_run_outputs
    WHERE analysis_run_id = ${runId}
      AND output_key LIKE ${`${prefix}%`}
  `;
}

export async function replaceTranscriptSegments(
  runId: string,
  transcript: TranscriptSegment[],
) {
  await ensureSchema();
  const sql = getSql();
  await sql`DELETE FROM transcript_segments WHERE analysis_run_id = ${runId}`;

  for (const [index, segment] of transcript.entries()) {
    await sql`
      INSERT INTO transcript_segments (
        id,
        analysis_run_id,
        segment_index,
        start_sec,
        end_sec,
        text
      )
      VALUES (
        ${randomUUID()},
        ${runId},
        ${index},
        ${segment.startSec},
        ${segment.endSec},
        ${segment.text}
      )
    `;
  }
}

export async function replaceScreenshotFrames(
  runId: string,
  screenshots: ScreenshotInsight[],
) {
  await ensureSchema();
  const sql = getSql();
  await sql`DELETE FROM screenshot_frames WHERE analysis_run_id = ${runId}`;

  for (const [index, screenshot] of screenshots.entries()) {
    await sql`
      INSERT INTO screenshot_frames (
        id,
        analysis_run_id,
        artifact_id,
        frame_index,
        timestamp_sec,
        page_label,
        caption,
        raw_notes,
        objects
      )
      VALUES (
        ${randomUUID()},
        ${runId},
        ${screenshot.artifactId ?? null},
        ${index},
        ${screenshot.timestampSec},
        ${screenshot.pageLabel ?? null},
        ${screenshot.caption},
        ${screenshot.rawNotes ?? null},
        ${JSON.stringify(screenshot.objects)}::jsonb
      )
    `;
  }
}

export async function replaceFlowSteps(runId: string, flowSteps: FlowStep[]) {
  await ensureSchema();
  const sql = getSql();
  await sql`DELETE FROM flow_steps WHERE analysis_run_id = ${runId}`;

  for (const flowStep of flowSteps) {
    await sql`
      INSERT INTO flow_steps (
        id,
        analysis_run_id,
        step_index,
        start_sec,
        end_sec,
        title,
        summary,
        user_goal
      )
      VALUES (
        ${randomUUID()},
        ${runId},
        ${flowStep.step},
        ${flowStep.startSec},
        ${flowStep.endSec},
        ${flowStep.title},
        ${flowStep.summary},
        ${flowStep.userGoal}
      )
    `;
  }
}

export async function replaceMoments(runId: string, moments: Moment[]) {
  await ensureSchema();
  const sql = getSql();
  await sql`DELETE FROM moments WHERE analysis_run_id = ${runId}`;

  for (const moment of moments) {
    await sql`
      INSERT INTO moments (
        id,
        analysis_run_id,
        start_sec,
        end_sec,
        category,
        severity,
        title,
        summary,
        quote,
        evidence,
        suggested_ticket_title,
        acceptance_criteria
      )
      VALUES (
        ${randomUUID()},
        ${runId},
        ${moment.startSec},
        ${moment.endSec},
        ${moment.category},
        ${moment.severity},
        ${moment.title},
        ${moment.summary},
        ${moment.quote ?? null},
        ${JSON.stringify(moment.evidence ?? [])}::jsonb,
        ${moment.suggestedTicketTitle ?? null},
        ${JSON.stringify(moment.acceptanceCriteria ?? [])}::jsonb
      )
    `;
  }
}

export async function replaceMemory(
  runId: string,
  params: {
    entities: MemoryEntity[];
    relationships: MemoryRelationship[];
  },
) {
  await ensureSchema();
  const sql = getSql();
  await sql`DELETE FROM memory_relationships WHERE analysis_run_id = ${runId}`;
  await sql`DELETE FROM memory_entities WHERE analysis_run_id = ${runId}`;

  for (const entity of params.entities) {
    await sql`
      INSERT INTO memory_entities (
        id,
        analysis_run_id,
        entity_type,
        name,
        description,
        confidence,
        first_seen_sec,
        last_seen_sec,
        source_evidence
      )
      VALUES (
        ${randomUUID()},
        ${runId},
        ${entity.entityType},
        ${entity.name},
        ${entity.description},
        ${entity.confidence},
        ${entity.firstSeenSec ?? null},
        ${entity.lastSeenSec ?? null},
        ${JSON.stringify(entity.sourceEvidence ?? [])}::jsonb
      )
    `;
  }

  for (const relationship of params.relationships) {
    await sql`
      INSERT INTO memory_relationships (
        id,
        analysis_run_id,
        from_entity,
        to_entity,
        relationship_type,
        description,
        confidence
      )
      VALUES (
        ${randomUUID()},
        ${runId},
        ${relationship.fromEntity},
        ${relationship.toEntity},
        ${relationship.relationshipType},
        ${relationship.description},
        ${relationship.confidence}
      )
    `;
  }
}

export async function replaceReports(
  runId: string,
  reports: {
    bugReport: { content: BugReport; html: string };
    objectModelReport: { content: ObjectModelReport; html: string };
    timelineReport: { content: TimelineReport; html: string };
  },
) {
  await ensureSchema();
  const sql = getSql();
  await sql`DELETE FROM reports WHERE analysis_run_id = ${runId}`;

  const entries = Object.entries(reports) as Array<
    [
      "bugReport" | "objectModelReport" | "timelineReport",
      { content: BugReport | ObjectModelReport | TimelineReport; html: string },
    ]
  >;

  for (const [reportType, report] of entries) {
    await sql`
      INSERT INTO reports (id, analysis_run_id, report_type, content, html)
      VALUES (
        ${randomUUID()},
        ${runId},
        ${reportType},
        ${JSON.stringify(report.content)}::jsonb,
        ${report.html}
      )
    `;
  }
}

export async function listVideos() {
  await ensureSchema();
  const sql = getSql();
  const rows = asRows(await sql`
    SELECT
      v.id,
      v.title,
      v.status,
      v.created_at,
      v.updated_at,
      a.id AS artifact_id,
      a.kind AS artifact_kind,
      a.storage_backend AS artifact_storage_backend,
      a.storage_key AS artifact_storage_key,
      a.public_url AS artifact_public_url,
      a.mime_type AS artifact_mime_type,
      a.size_bytes AS artifact_size_bytes,
      a.metadata AS artifact_metadata,
      a.created_at AS artifact_created_at,
      r.id AS run_id,
      r.video_id AS run_video_id,
      r.status AS run_status,
      r.mode AS run_mode,
      r.prompt AS run_prompt,
      r.stage AS run_stage,
      r.error AS run_error,
      r.config_version AS run_config_version,
      r.created_at AS run_created_at,
      r.updated_at AS run_updated_at,
      r.completed_at AS run_completed_at,
      COALESCE(rs.total_jobs, 0) AS run_total_jobs,
      COALESCE(rs.queued_jobs, 0) AS run_queued_jobs,
      COALESCE(rs.processing_jobs, 0) AS run_processing_jobs,
      COALESCE(rs.completed_jobs, 0) AS run_completed_jobs,
      COALESCE(rs.failed_jobs, 0) AS run_failed_jobs,
      COALESCE(rs.cancelled_jobs, 0) AS run_cancelled_jobs,
      COALESCE(rs.transcription_total, 0) AS run_transcription_total,
      COALESCE(rs.transcription_completed, 0) AS run_transcription_completed,
      COALESCE(rs.clip_total, 0) AS run_clip_total,
      COALESCE(rs.clip_completed, 0) AS run_clip_completed,
      COALESCE(rs.snapshot_total, 0) AS run_snapshot_total,
      COALESCE(rs.snapshot_completed, 0) AS run_snapshot_completed,
      (SELECT COUNT(*) FROM transcript_segments ts WHERE ts.analysis_run_id = r.id) AS transcript_count,
      (SELECT COUNT(*) FROM moments m WHERE m.analysis_run_id = r.id) AS moment_count,
      (SELECT COUNT(*) FROM screenshot_frames sf WHERE sf.analysis_run_id = r.id) AS screenshot_count,
      (SELECT COUNT(*) FROM memory_entities me WHERE me.analysis_run_id = r.id) AS entity_count
    FROM videos v
    JOIN artifacts a ON a.id = v.source_artifact_id
    LEFT JOIN LATERAL (
      SELECT *
      FROM analysis_runs
      WHERE video_id = v.id
      ORDER BY created_at DESC
      LIMIT 1
    ) r ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS total_jobs,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued_jobs,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing_jobs,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed_jobs,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed_jobs,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_jobs,
        COUNT(*) FILTER (WHERE job_type IN ('transcribe_audio_chunk', 'transcribe_video_url'))
          AS transcription_total,
        COUNT(*) FILTER (
          WHERE job_type IN ('transcribe_audio_chunk', 'transcribe_video_url')
            AND status = 'completed'
        ) AS transcription_completed,
        COUNT(*) FILTER (WHERE job_type = 'analyze_clip') AS clip_total,
        COUNT(*) FILTER (
          WHERE job_type = 'analyze_clip'
            AND status = 'completed'
        ) AS clip_completed,
        COUNT(*) FILTER (WHERE job_type = 'analyze_snapshot') AS snapshot_total,
        COUNT(*) FILTER (
          WHERE job_type = 'analyze_snapshot'
            AND status = 'completed'
        ) AS snapshot_completed
      FROM analysis_jobs
      WHERE analysis_run_id = r.id
    ) rs ON TRUE
    ORDER BY v.created_at DESC
  `);

  return rows.map((row) => {
    const record = row;
    const latestRun = mapRun(record);

    return {
      id: String(record.id),
      title: String(record.title),
      status: String(record.status) as VideoListItem["status"],
      sourceArtifact: mapArtifact(record),
      createdAt: toIso(record.created_at),
      updatedAt: toIso(record.updated_at),
      latestRun,
      counts: {
        transcriptSegments: toNumber(record.transcript_count),
        moments: toNumber(record.moment_count),
        screenshots: toNumber(record.screenshot_count),
        entities: toNumber(record.entity_count),
      },
    } satisfies VideoListItem;
  });
}

export async function getVideoDetail(videoId: string) {
  await ensureSchema();
  const sql = getSql();
  const rows = asRows(await sql`
    SELECT
      v.id,
      v.title,
      v.status,
      v.created_at,
      v.updated_at,
      a.id AS artifact_id,
      a.kind AS artifact_kind,
      a.storage_backend AS artifact_storage_backend,
      a.storage_key AS artifact_storage_key,
      a.public_url AS artifact_public_url,
      a.mime_type AS artifact_mime_type,
      a.size_bytes AS artifact_size_bytes,
      a.metadata AS artifact_metadata,
      a.created_at AS artifact_created_at,
      r.id AS run_id,
      r.video_id AS run_video_id,
      r.status AS run_status,
      r.mode AS run_mode,
      r.prompt AS run_prompt,
      r.stage AS run_stage,
      r.error AS run_error,
      r.config_version AS run_config_version,
      r.created_at AS run_created_at,
      r.updated_at AS run_updated_at,
      r.completed_at AS run_completed_at,
      COALESCE(rs.total_jobs, 0) AS run_total_jobs,
      COALESCE(rs.queued_jobs, 0) AS run_queued_jobs,
      COALESCE(rs.processing_jobs, 0) AS run_processing_jobs,
      COALESCE(rs.completed_jobs, 0) AS run_completed_jobs,
      COALESCE(rs.failed_jobs, 0) AS run_failed_jobs,
      COALESCE(rs.cancelled_jobs, 0) AS run_cancelled_jobs,
      COALESCE(rs.transcription_total, 0) AS run_transcription_total,
      COALESCE(rs.transcription_completed, 0) AS run_transcription_completed,
      COALESCE(rs.clip_total, 0) AS run_clip_total,
      COALESCE(rs.clip_completed, 0) AS run_clip_completed,
      COALESCE(rs.snapshot_total, 0) AS run_snapshot_total,
      COALESCE(rs.snapshot_completed, 0) AS run_snapshot_completed
    FROM videos v
    JOIN artifacts a ON a.id = v.source_artifact_id
    LEFT JOIN LATERAL (
      SELECT *
      FROM analysis_runs
      WHERE video_id = v.id
      ORDER BY created_at DESC
      LIMIT 1
    ) r ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS total_jobs,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued_jobs,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing_jobs,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed_jobs,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed_jobs,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_jobs,
        COUNT(*) FILTER (WHERE job_type IN ('transcribe_audio_chunk', 'transcribe_video_url'))
          AS transcription_total,
        COUNT(*) FILTER (
          WHERE job_type IN ('transcribe_audio_chunk', 'transcribe_video_url')
            AND status = 'completed'
        ) AS transcription_completed,
        COUNT(*) FILTER (WHERE job_type = 'analyze_clip') AS clip_total,
        COUNT(*) FILTER (
          WHERE job_type = 'analyze_clip'
            AND status = 'completed'
        ) AS clip_completed,
        COUNT(*) FILTER (WHERE job_type = 'analyze_snapshot') AS snapshot_total,
        COUNT(*) FILTER (
          WHERE job_type = 'analyze_snapshot'
            AND status = 'completed'
        ) AS snapshot_completed
      FROM analysis_jobs
      WHERE analysis_run_id = r.id
    ) rs ON TRUE
    WHERE v.id = ${videoId}
  `);

  if (rows.length === 0) return null;

  const record = rows[0];
  const latestRun = mapRun(record);

  let transcript: TranscriptSegment[] = [];
  let screenshots: ScreenshotInsight[] = [];
  let flowSteps: FlowStep[] = [];
  let moments: Moment[] = [];
  let entities: MemoryEntity[] = [];
  let relationships: MemoryRelationship[] = [];
  let bugReport: BugReport | null = null;
  let objectModelReport: ObjectModelReport | null = null;
  let timelineReport: TimelineReport | null = null;

  if (latestRun) {
    const transcriptRows = asRows(await sql`
      SELECT start_sec, end_sec, text
      FROM transcript_segments
      WHERE analysis_run_id = ${latestRun.id}
      ORDER BY segment_index ASC
    `);
    transcript = transcriptRows.map((row) => ({
      startSec: toNumber(row.start_sec),
      endSec: toNumber(row.end_sec),
      text: String(row.text),
    }));

    const screenshotRows = asRows(await sql`
      SELECT
        sf.id,
        sf.artifact_id,
        a.public_url,
        sf.timestamp_sec,
        sf.page_label,
        sf.caption,
        sf.raw_notes,
        sf.objects
      FROM screenshot_frames sf
      LEFT JOIN artifacts a ON a.id = sf.artifact_id
      WHERE sf.analysis_run_id = ${latestRun.id}
      ORDER BY sf.frame_index ASC
    `);
    screenshots = screenshotRows.map((row) => ({
      id: String(row.id),
      artifactId: row.artifact_id == null ? undefined : String(row.artifact_id),
      imageUrl: row.public_url == null ? null : String(row.public_url),
      timestampSec: toNumber(row.timestamp_sec),
      pageLabel: row.page_label == null ? null : String(row.page_label),
      caption: String(row.caption),
      rawNotes: row.raw_notes == null ? null : String(row.raw_notes),
      objects: asJson<ScreenshotInsight["objects"]>(row.objects, []),
    }));

    const flowRows = asRows(await sql`
      SELECT step_index, start_sec, end_sec, title, summary, user_goal
      FROM flow_steps
      WHERE analysis_run_id = ${latestRun.id}
      ORDER BY step_index ASC
    `);
    flowSteps = flowRows.map((row) => ({
      step: toNumber(row.step_index),
      startSec: toNumber(row.start_sec),
      endSec: toNumber(row.end_sec),
      title: String(row.title),
      summary: String(row.summary),
      userGoal: String(row.user_goal),
    }));

    const momentRows = asRows(await sql`
      SELECT
        id,
        start_sec,
        end_sec,
        category,
        severity,
        title,
        summary,
        quote,
        evidence,
        suggested_ticket_title,
        acceptance_criteria
      FROM moments
      WHERE analysis_run_id = ${latestRun.id}
      ORDER BY start_sec ASC
    `);
    moments = momentRows.map((row) => ({
      id: String(row.id),
      startSec: toNumber(row.start_sec),
      endSec: toNumber(row.end_sec),
      category: String(row.category) as Moment["category"],
      severity: String(row.severity) as Moment["severity"],
      title: String(row.title),
      summary: String(row.summary),
      quote: row.quote == null ? null : String(row.quote),
      evidence: asJson<string[]>(row.evidence, []),
      suggestedTicketTitle:
        row.suggested_ticket_title == null
          ? null
          : String(row.suggested_ticket_title),
      acceptanceCriteria: asJson<string[]>(row.acceptance_criteria, []),
    }));

    const entityRows = asRows(await sql`
      SELECT
        id,
        entity_type,
        name,
        description,
        confidence,
        first_seen_sec,
        last_seen_sec,
        source_evidence
      FROM memory_entities
      WHERE analysis_run_id = ${latestRun.id}
      ORDER BY name ASC
    `);
    entities = entityRows.map((row) => ({
      id: String(row.id),
      entityType: String(row.entity_type),
      name: String(row.name),
      description: String(row.description),
      confidence: toNumber(row.confidence),
      firstSeenSec:
        row.first_seen_sec == null ? null : toNumber(row.first_seen_sec),
      lastSeenSec: row.last_seen_sec == null ? null : toNumber(row.last_seen_sec),
      sourceEvidence: asJson<string[]>(row.source_evidence, []),
    }));

    const relationshipRows = asRows(await sql`
      SELECT
        id,
        from_entity,
        to_entity,
        relationship_type,
        description,
        confidence
      FROM memory_relationships
      WHERE analysis_run_id = ${latestRun.id}
      ORDER BY from_entity ASC, to_entity ASC
    `);
    relationships = relationshipRows.map((row) => ({
      id: String(row.id),
      fromEntity: String(row.from_entity),
      toEntity: String(row.to_entity),
      relationshipType: String(row.relationship_type),
      description: String(row.description),
      confidence: toNumber(row.confidence),
    }));

    const reportRows = asRows(await sql`
      SELECT report_type, content
      FROM reports
      WHERE analysis_run_id = ${latestRun.id}
    `);

    for (const reportRow of reportRows) {
      if (reportRow.report_type === "bugReport") {
        bugReport = asJson<BugReport>(reportRow.content, {
          summary: "",
          tickets: [],
        });
      }
      if (reportRow.report_type === "objectModelReport") {
        objectModelReport = asJson<ObjectModelReport>(reportRow.content, {
          summary: "",
          objects: [],
          relationships: [],
          unknowns: [],
        });
      }
      if (reportRow.report_type === "timelineReport") {
        timelineReport = asJson<TimelineReport>(reportRow.content, {
          summary: "",
          highlights: [],
        });
      }
    }
  }

  return {
    id: String(record.id),
    title: String(record.title),
    status: String(record.status) as VideoDetail["status"],
    sourceArtifact: mapArtifact(record),
    createdAt: toIso(record.created_at),
    updatedAt: toIso(record.updated_at),
    latestRun,
    analysis: latestRun,
    transcript,
    screenshots,
    flowSteps,
    moments,
    entities,
    relationships,
    reports: {
      bugReport,
      objectModelReport,
      timelineReport,
    },
  } satisfies VideoDetail;
}

export async function persistAnalysis(
  runId: string,
  analysis: AnalysisResult,
  reportsHtml: {
    bugReport: string;
    objectModelReport: string;
    timelineReport: string;
  },
) {
  await replaceTranscriptSegments(runId, analysis.transcript);
  await replaceScreenshotFrames(runId, analysis.screenshots);
  await replaceFlowSteps(runId, analysis.flowSteps);
  await replaceMoments(runId, analysis.moments);
  await replaceMemory(runId, {
    entities: analysis.entities,
    relationships: analysis.relationships,
  });
  await replaceReports(runId, {
    bugReport: {
      content: analysis.reports.bugReport,
      html: reportsHtml.bugReport,
    },
    objectModelReport: {
      content: analysis.reports.objectModelReport,
      html: reportsHtml.objectModelReport,
    },
    timelineReport: {
      content: analysis.reports.timelineReport,
      html: reportsHtml.timelineReport,
    },
  });
}

export async function getLatestReportForVideo(
  videoId: string,
  reportType: "bugReport" | "objectModelReport" | "timelineReport",
) {
  await ensureSchema();
  const sql = getSql();
  const rows = asRows(await sql`
    SELECT rp.report_type, rp.content, rp.html
    FROM reports rp
    JOIN analysis_runs ar ON ar.id = rp.analysis_run_id
    WHERE ar.video_id = ${videoId}
      AND rp.report_type = ${reportType}
    ORDER BY ar.created_at DESC
    LIMIT 1
  `);

  if (rows.length === 0) return null;

  return {
    reportType: String(rows[0].report_type),
    content: asJson<Record<string, unknown>>(rows[0].content, {}),
    html: String(rows[0].html),
  };
}
