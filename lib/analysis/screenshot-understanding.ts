import { Type } from "@google/genai";
import { normalizeConfidence } from "@/lib/analysis/normalize-confidence";
import {
  screenshotInsightSchema,
  type ScreenshotInsight,
} from "@/lib/types";
import { generateJsonFromUploadedFile } from "@/lib/analysis/gemini-client";

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    pageLabel: { type: Type.STRING, nullable: true },
    caption: { type: Type.STRING },
    rawNotes: { type: Type.STRING, nullable: true },
    objects: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        propertyOrdering: ["kind", "label", "text", "confidence"],
        properties: {
          kind: { type: Type.STRING },
          label: { type: Type.STRING },
          text: { type: Type.STRING, nullable: true },
          confidence: { type: Type.NUMBER },
        },
        required: ["kind", "label", "confidence"],
      },
    },
  },
  required: ["caption", "objects"],
};

const SYSTEM_PROMPT = `You analyze screenshots from web app product walkthroughs.
Describe what the user can see on screen.
Focus on visible UI structure, nouns, state, and obvious objects.
Return strict JSON only.
Keep captions concise but specific.
Object kinds should be concrete words such as page, nav, modal, table, button, input, list, record, chart, status, or dialog.
Confidence must be a decimal from 0 to 1, not a percentage.`;

export async function understandScreenshot(params: {
  filePath: string;
  mimeType: string;
  timestampSec: number;
  focusPrompt?: string;
  contextLabel?: string;
  transcriptExcerpt?: string[];
  rationale?: string;
}) {
  const result = await generateJsonFromUploadedFile<
    Omit<ScreenshotInsight, "timestampSec">
  >({
    filePath: params.filePath,
    mimeType: params.mimeType,
    displayName: "pm-video-analyzer-screenshot",
    responseSchema,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Analyze this screenshot captured at ${params.timestampSec.toFixed(
      1,
    )} seconds and describe the visible application state.
${params.contextLabel ? `\nContext label: ${params.contextLabel}` : ""}
${params.rationale ? `\nWhy this frame was selected: ${params.rationale}` : ""}
${
  params.transcriptExcerpt && params.transcriptExcerpt.length > 0
    ? `\nNearby transcript:\n${params.transcriptExcerpt.join("\n")}`
    : ""
}
${
  params.focusPrompt
    ? `\nFocus especially on this user request:\n${params.focusPrompt}`
    : ""
}`,
  });

  return screenshotInsightSchema.parse({
    ...result,
    objects: result.objects.map((object) => ({
      ...object,
      confidence: normalizeConfidence(object.confidence),
    })),
    timestampSec: params.timestampSec,
  });
}
