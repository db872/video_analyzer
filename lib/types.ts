import { z } from "zod";

export const videoStatusSchema = z.enum([
  "uploaded",
  "processing",
  "ready",
  "failed",
]);

export const analysisRunStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
]);

export const analysisModeSchema = z.enum(["pm_report", "analyze"]);

export const analysisJobStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export const analysisJobTypeSchema = z.enum([
  "prepare_media",
  "transcribe_audio_chunk",
  "transcribe_video_url",
  "merge_transcript",
  "analyze_moments",
  "analyze_clip",
  "merge_clip_findings",
  "build_object_model",
  "select_snapshots",
  "analyze_snapshot",
  "merge_snapshots",
  "finalize_run",
]);

export const artifactKindSchema = z.enum([
  "source_video",
  "boosted_audio",
  "screenshot",
]);

export const storageBackendSchema = z.enum(["local", "blob", "external"]);

export const momentCategorySchema = z.enum([
  "frustration",
  "bug",
  "feature_request",
]);

export const severitySchema = z.enum(["low", "medium", "high"]);

export const transcriptSegmentSchema = z.object({
  startSec: z.number(),
  endSec: z.number(),
  text: z.string(),
});

export const screenshotObjectSchema = z.object({
  kind: z.string(),
  label: z.string(),
  text: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
});

export const screenshotInsightSchema = z.object({
  id: z.string().optional(),
  artifactId: z.string().optional(),
  imageUrl: z.string().nullable().optional(),
  timestampSec: z.number(),
  pageLabel: z.string().nullable().optional(),
  caption: z.string(),
  rawNotes: z.string().nullable().optional(),
  objects: z.array(screenshotObjectSchema),
});

export const flowStepSchema = z.object({
  step: z.number().int().positive(),
  startSec: z.number(),
  endSec: z.number(),
  title: z.string(),
  summary: z.string(),
  userGoal: z.string(),
});

export const momentSchema = z.object({
  id: z.string().optional(),
  startSec: z.number(),
  endSec: z.number(),
  category: momentCategorySchema,
  severity: severitySchema,
  title: z.string(),
  summary: z.string(),
  quote: z.string().optional().nullable(),
  evidence: z.array(z.string()).default([]),
  suggestedTicketTitle: z.string().nullable().optional(),
  acceptanceCriteria: z.array(z.string()).default([]),
});

export const memoryEntitySchema = z.object({
  id: z.string().optional(),
  entityType: z.string(),
  name: z.string(),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  firstSeenSec: z.number().nullable().optional(),
  lastSeenSec: z.number().nullable().optional(),
  sourceEvidence: z.array(z.string()).default([]),
});

export const memoryRelationshipSchema = z.object({
  id: z.string().optional(),
  fromEntity: z.string(),
  toEntity: z.string(),
  relationshipType: z.string(),
  description: z.string(),
  confidence: z.number().min(0).max(1),
});

export const bugTicketSchema = z.object({
  title: z.string(),
  severity: severitySchema,
  summary: z.string(),
  reproductionContext: z.string(),
  evidence: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
});

export const bugReportSchema = z.object({
  summary: z.string(),
  tickets: z.array(bugTicketSchema),
});

export const objectModelReportSchema = z.object({
  summary: z.string(),
  objects: z.array(memoryEntitySchema),
  relationships: z.array(memoryRelationshipSchema),
  unknowns: z.array(z.string()).default([]),
});

export const timelineReportSchema = z.object({
  summary: z.string(),
  highlights: z.array(z.string()).default([]),
});

export const analysisResultSchema = z.object({
  transcript: z.array(transcriptSegmentSchema),
  screenshots: z.array(screenshotInsightSchema),
  flowSteps: z.array(flowStepSchema),
  moments: z.array(momentSchema),
  entities: z.array(memoryEntitySchema),
  relationships: z.array(memoryRelationshipSchema),
  reports: z.object({
    bugReport: bugReportSchema,
    objectModelReport: objectModelReportSchema,
    timelineReport: timelineReportSchema,
  }),
});

export const storedArtifactSchema = z.object({
  id: z.string(),
  kind: artifactKindSchema,
  storageBackend: storageBackendSchema,
  storageKey: z.string(),
  publicUrl: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});

export const analysisRunSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  status: analysisRunStatusSchema,
  mode: analysisModeSchema,
  prompt: z.string().nullable(),
  stage: z.string(),
  error: z.string().nullable(),
  configVersion: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  progress: z.object({
    totalJobs: z.number().int().nonnegative(),
    queuedJobs: z.number().int().nonnegative(),
    processingJobs: z.number().int().nonnegative(),
    completedJobs: z.number().int().nonnegative(),
    failedJobs: z.number().int().nonnegative(),
    cancelledJobs: z.number().int().nonnegative(),
    transcriptionTotal: z.number().int().nonnegative(),
    transcriptionCompleted: z.number().int().nonnegative(),
    clipTotal: z.number().int().nonnegative(),
    clipCompleted: z.number().int().nonnegative(),
    snapshotTotal: z.number().int().nonnegative(),
    snapshotCompleted: z.number().int().nonnegative(),
  }),
});

export const analysisJobSchema = z.object({
  id: z.string(),
  analysisRunId: z.string(),
  jobType: analysisJobTypeSchema,
  status: analysisJobStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  priority: z.number().int(),
  availableAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const videoSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: videoStatusSchema,
  sourceArtifact: storedArtifactSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  latestRun: analysisRunSchema.nullable(),
});

export const videoListItemSchema = videoSchema.extend({
  counts: z.object({
    transcriptSegments: z.number().int().nonnegative(),
    moments: z.number().int().nonnegative(),
    screenshots: z.number().int().nonnegative(),
    entities: z.number().int().nonnegative(),
  }),
});

export const videoDetailSchema = videoSchema.extend({
  analysis: analysisRunSchema.nullable(),
  transcript: z.array(transcriptSegmentSchema),
  screenshots: z.array(screenshotInsightSchema),
  flowSteps: z.array(flowStepSchema),
  moments: z.array(momentSchema),
  entities: z.array(memoryEntitySchema),
  relationships: z.array(memoryRelationshipSchema),
  reports: z.object({
    bugReport: bugReportSchema.nullable(),
    objectModelReport: objectModelReportSchema.nullable(),
    timelineReport: timelineReportSchema.nullable(),
  }),
});

export type VideoStatus = z.infer<typeof videoStatusSchema>;
export type AnalysisRunStatus = z.infer<typeof analysisRunStatusSchema>;
export type AnalysisMode = z.infer<typeof analysisModeSchema>;
export type AnalysisJobStatus = z.infer<typeof analysisJobStatusSchema>;
export type AnalysisJobType = z.infer<typeof analysisJobTypeSchema>;
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type StorageBackend = z.infer<typeof storageBackendSchema>;
export type MomentCategory = z.infer<typeof momentCategorySchema>;
export type Severity = z.infer<typeof severitySchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type ScreenshotObject = z.infer<typeof screenshotObjectSchema>;
export type ScreenshotInsight = z.infer<typeof screenshotInsightSchema>;
export type FlowStep = z.infer<typeof flowStepSchema>;
export type Moment = z.infer<typeof momentSchema>;
export type MemoryEntity = z.infer<typeof memoryEntitySchema>;
export type MemoryRelationship = z.infer<typeof memoryRelationshipSchema>;
export type BugTicket = z.infer<typeof bugTicketSchema>;
export type BugReport = z.infer<typeof bugReportSchema>;
export type ObjectModelReport = z.infer<typeof objectModelReportSchema>;
export type TimelineReport = z.infer<typeof timelineReportSchema>;
export type AnalysisResult = z.infer<typeof analysisResultSchema>;
export type StoredArtifact = z.infer<typeof storedArtifactSchema>;
export type AnalysisRun = z.infer<typeof analysisRunSchema>;
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
export type Video = z.infer<typeof videoSchema>;
export type VideoListItem = z.infer<typeof videoListItemSchema>;
export type VideoDetail = z.infer<typeof videoDetailSchema>;
