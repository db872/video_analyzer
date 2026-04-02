import { Type } from "@google/genai";
import { getGeminiModelName } from "@/lib/analysis/gemini-client";
import {
  generateJsonFromUploadedFile,
  generateJsonFromVideoUrl,
} from "@/lib/analysis/gemini-client";
import { z } from "zod";

const clipFindingSchema = z.object({
  startSec: z.number(),
  endSec: z.number(),
  title: z.string(),
  summary: z.string(),
  visualEvidence: z.array(z.string()).default([]),
  visibleObjects: z.array(z.string()).default([]),
  objectHints: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
});

export type ClipFinding = z.infer<typeof clipFindingSchema>;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    summary: { type: Type.STRING },
    visualEvidence: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    visibleObjects: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    objectHints: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    acceptanceCriteria: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: ["title", "summary", "visualEvidence", "visibleObjects", "objectHints", "acceptanceCriteria"],
};

const SYSTEM_PROMPT = `You analyze short video clips from narrated web app walkthroughs.
Use the clip visuals together with the provided transcript context.
Return strict JSON only.
Focus on what visually happens in the UI, what state the app appears to be in, and what objects or workflows are visible.
Do not restate the entire transcript; add only clip-specific visual understanding.`;

function compactTranscriptExcerpt(excerpt: string[]) {
  return excerpt.join("\n");
}

function formatTimestamp(totalSeconds: number) {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const seconds = whole % 60;
  const minutes = Math.floor(whole / 60) % 60;
  const hours = Math.floor(whole / 3600);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

export async function analyzeTargetClip(params: {
  filePath: string;
  mimeType: string;
  startSec: number;
  endSec: number;
  transcriptExcerpt: string[];
  contextLabel: string;
}) {
  const result = await generateJsonFromUploadedFile<Omit<
    ClipFinding,
    "startSec" | "endSec"
  >>({
    filePath: params.filePath,
    mimeType: params.mimeType,
    displayName: `pm-video-analyzer-clip-${params.contextLabel}`,
    responseSchema,
    model: getGeminiModelName(),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `This clip is from ${params.startSec.toFixed(2)}s to ${params.endSec.toFixed(
      2,
    )}s of the full walkthrough.

Context label: ${params.contextLabel}

Nearby transcript:
${compactTranscriptExcerpt(params.transcriptExcerpt)}

Analyze what visually happens in this clip and what it suggests about the user's flow.`,
  });

  return clipFindingSchema.parse({
    ...result,
    startSec: params.startSec,
    endSec: params.endSec,
  });
}

export async function analyzeTargetClipFromVideoUrl(params: {
  videoUrl: string;
  startSec: number;
  endSec: number;
  transcriptExcerpt: string[];
  contextLabel: string;
}) {
  const result = await generateJsonFromVideoUrl<Omit<
    ClipFinding,
    "startSec" | "endSec"
  >>({
    videoUrl: params.videoUrl,
    displayName: `pm-video-analyzer-youtube-${params.contextLabel}`,
    responseSchema,
    model: getGeminiModelName(),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `This video is a full public YouTube walkthrough.

Focus only on what happens from ${formatTimestamp(params.startSec)} to ${formatTimestamp(
      params.endSec,
    )} in the full video.

Context label: ${params.contextLabel}

Nearby transcript:
${compactTranscriptExcerpt(params.transcriptExcerpt)}

Analyze the UI state, visible objects, and user flow within that time window only. Ignore other parts of the video unless they are necessary to disambiguate this moment.`,
  });

  return clipFindingSchema.parse({
    ...result,
    startSec: params.startSec,
    endSec: params.endSec,
  });
}
