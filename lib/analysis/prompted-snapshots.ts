import { Type } from "@google/genai";
import { analyzeTargetClipFromVideoUrl } from "@/lib/analysis/clip-understanding";
import { generateJsonFromText } from "@/lib/analysis/gemini-client";
import { understandScreenshot } from "@/lib/analysis/screenshot-understanding";
import { extractVideoFrame } from "@/lib/server/ffmpeg";
import {
  screenshotInsightSchema,
  type ScreenshotInsight,
  type TranscriptSegment,
} from "@/lib/types";
import { z } from "zod";

const candidateSchema = z.object({
  timestampSec: z.number().min(0),
  title: z.string(),
  rationale: z.string(),
  transcriptEvidence: z.array(z.string()).default([]),
});

export type SnapshotCandidate = z.infer<typeof candidateSchema>;

export type PromptedSnapshotResult = Omit<
  ScreenshotInsight,
  "id" | "artifactId" | "imageUrl"
> & {
  imagePath?: string | null;
};

export type PromptedSnapshotRun = {
  summary: string;
  snapshots: PromptedSnapshotResult[];
};

export type PromptedSnapshotSelection = {
  summary: string;
  snapshots: SnapshotCandidate[];
};

const selectionResponseSchema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    snapshots: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        propertyOrdering: [
          "timestampSec",
          "title",
          "rationale",
          "transcriptEvidence",
        ],
        properties: {
          timestampSec: { type: Type.NUMBER },
          title: { type: Type.STRING },
          rationale: { type: Type.STRING },
          transcriptEvidence: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ["timestampSec", "title", "rationale", "transcriptEvidence"],
      },
    },
  },
  required: ["summary", "snapshots"],
};

const SELECTION_SYSTEM_PROMPT = `You review transcripts from narrated product walkthrough videos.
Return strict JSON only.
Select the most interesting moments to capture as concise research notes, based on the user's focus prompt.
Choose moments that are visually meaningful, distinct from each other, and likely to benefit from a saved note or snapshot.
Prefer 4-8 timestamps spread across the walkthrough unless the transcript clearly supports fewer.
Each rationale should explain why that moment matters for the user's prompt.`;

function compactTranscript(transcript: TranscriptSegment[]) {
  return transcript
    .map(
      (segment) =>
        `[${segment.startSec.toFixed(1)}-${segment.endSec.toFixed(1)}] ${segment.text}`,
    )
    .join("\n");
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
    .slice(0, 10);
}

export async function selectInterestingSnapshots(params: {
  transcript: TranscriptSegment[];
  userPrompt: string;
}): Promise<PromptedSnapshotSelection> {
  const result = await generateJsonFromText<{
    summary: string;
    snapshots: SnapshotCandidate[];
  }>({
    responseSchema: selectionResponseSchema,
    systemPrompt: SELECTION_SYSTEM_PROMPT,
    userPrompt: `User focus prompt:
${params.userPrompt}

Transcript:
${compactTranscript(params.transcript)}`,
  });

  return {
    summary: result.summary,
    snapshots: result.snapshots.map((snapshot) => candidateSchema.parse(snapshot)),
  };
}

function mergeRawNotes(rationale: string, rawNotes?: string | null) {
  return [rationale, rawNotes].filter(Boolean).join("\n\n");
}

function normalizeSnapshot(
  snapshot: Omit<ScreenshotInsight, "id" | "artifactId" | "imageUrl">,
  imagePath?: string | null,
) {
  const normalized = screenshotInsightSchema.parse({
    ...snapshot,
    imageUrl: null,
  });

  return {
    timestampSec: normalized.timestampSec,
    pageLabel: normalized.pageLabel,
    caption: normalized.caption,
    rawNotes: normalized.rawNotes,
    objects: normalized.objects,
    imagePath,
  } satisfies PromptedSnapshotResult;
}

function getMaxPromptedSnapshots() {
  const value = Number(process.env.MAX_PROMPTED_SNAPSHOTS ?? "6");
  return Number.isFinite(value) && value > 0 ? value : 6;
}

export async function analyzePromptedSnapshotsFromFile(params: {
  sourceVideoPath: string;
  workingDir: string;
  transcript: TranscriptSegment[];
  userPrompt: string;
}) {
  const selection = await selectInterestingSnapshots(params);
  const snapshots: PromptedSnapshotResult[] = [];

  for (const [index, candidate] of selection.snapshots
    .slice(0, getMaxPromptedSnapshots())
    .entries()) {
    snapshots.push(
      await analyzePromptedSnapshotFromFile({
        sourceVideoPath: params.sourceVideoPath,
        workingDir: params.workingDir,
        transcript: params.transcript,
        userPrompt: params.userPrompt,
        candidate,
        index,
      }),
    );
  }

  return {
    summary: selection.summary,
    snapshots,
  } satisfies PromptedSnapshotRun;
}

export async function analyzePromptedSnapshotsFromVideoUrl(params: {
  videoUrl: string;
  transcript: TranscriptSegment[];
  userPrompt: string;
}) {
  const selection = await selectInterestingSnapshots(params);
  const snapshots: PromptedSnapshotResult[] = [];

  for (const [index, candidate] of selection.snapshots
    .slice(0, getMaxPromptedSnapshots())
    .entries()) {
    snapshots.push(
      await analyzePromptedSnapshotFromVideoUrl({
        videoUrl: params.videoUrl,
        transcript: params.transcript,
        candidate,
        index,
      }),
    );
  }

  return {
    summary: selection.summary,
    snapshots,
  } satisfies PromptedSnapshotRun;
}

export async function analyzePromptedSnapshotFromFile(params: {
  sourceVideoPath: string;
  workingDir: string;
  transcript: TranscriptSegment[];
  userPrompt: string;
  candidate: SnapshotCandidate;
  index: number;
}) {
  const framePath = await extractVideoFrame({
    videoPath: params.sourceVideoPath,
    outputDir: params.workingDir,
    timestampSec: params.candidate.timestampSec,
    filename: `snapshot-${String(params.index).padStart(3, "0")}.jpg`,
  });

  const insight = await understandScreenshot({
    filePath: framePath,
    mimeType: "image/jpeg",
    timestampSec: params.candidate.timestampSec,
    focusPrompt: params.userPrompt,
    contextLabel: params.candidate.title,
    rationale: params.candidate.rationale,
    transcriptExcerpt: transcriptExcerptForRange(
      params.transcript,
      Math.max(0, params.candidate.timestampSec - 5),
      params.candidate.timestampSec + 5,
    ),
  });

  return normalizeSnapshot(
    {
      timestampSec: insight.timestampSec,
      pageLabel: insight.pageLabel ?? params.candidate.title,
      caption: insight.caption,
      rawNotes: mergeRawNotes(params.candidate.rationale, insight.rawNotes),
      objects: insight.objects,
    },
    framePath,
  );
}

export async function analyzePromptedSnapshotFromVideoUrl(params: {
  videoUrl: string;
  transcript: TranscriptSegment[];
  candidate: SnapshotCandidate;
  index: number;
}) {
  const clip = await analyzeTargetClipFromVideoUrl({
    videoUrl: params.videoUrl,
    startSec: Math.max(0, params.candidate.timestampSec - 4),
    endSec: params.candidate.timestampSec + 4,
    transcriptExcerpt: transcriptExcerptForRange(
      params.transcript,
      Math.max(0, params.candidate.timestampSec - 5),
      params.candidate.timestampSec + 5,
    ),
    contextLabel: params.candidate.title,
  });

  return normalizeSnapshot({
    timestampSec: params.candidate.timestampSec,
    pageLabel: clip.title,
    caption: clip.summary,
    rawNotes: mergeRawNotes(params.candidate.rationale, clip.visualEvidence.join("\n")),
    objects: Array.from(new Set([...clip.visibleObjects, ...clip.objectHints])).map(
      (label) => ({
        kind: "object",
        label,
        text: null,
        confidence: 0.7,
      }),
    ),
  });
}
