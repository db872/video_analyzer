import { Type } from "@google/genai";
import {
  flowStepSchema,
  momentSchema,
  type FlowStep,
  type Moment,
  type ScreenshotInsight,
  type TranscriptSegment,
} from "@/lib/types";
import { generateJsonFromText } from "@/lib/analysis/gemini-client";

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    flowSteps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        propertyOrdering: ["step", "startSec", "endSec", "title", "summary", "userGoal"],
        properties: {
          step: { type: Type.INTEGER },
          startSec: { type: Type.NUMBER },
          endSec: { type: Type.NUMBER },
          title: { type: Type.STRING },
          summary: { type: Type.STRING },
          userGoal: { type: Type.STRING },
        },
        required: ["step", "startSec", "endSec", "title", "summary", "userGoal"],
      },
    },
    moments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        propertyOrdering: [
          "startSec",
          "endSec",
          "category",
          "severity",
          "title",
          "summary",
          "quote",
          "evidence",
          "suggestedTicketTitle",
          "acceptanceCriteria",
        ],
        properties: {
          startSec: { type: Type.NUMBER },
          endSec: { type: Type.NUMBER },
          category: {
            type: Type.STRING,
            enum: ["frustration", "bug", "feature_request"],
          },
          severity: {
            type: Type.STRING,
            enum: ["low", "medium", "high"],
          },
          title: { type: Type.STRING },
          summary: { type: Type.STRING },
          quote: { type: Type.STRING, nullable: true },
          evidence: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          suggestedTicketTitle: { type: Type.STRING, nullable: true },
          acceptanceCriteria: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: [
          "startSec",
          "endSec",
          "category",
          "severity",
          "title",
          "summary",
          "evidence",
          "acceptanceCriteria",
        ],
      },
    },
  },
  required: ["flowSteps", "moments"],
};

const SYSTEM_PROMPT = `You analyze narrated screen recordings of web applications.
Use the transcript plus screenshot summaries to infer the user journey and the key problem moments.
Return strict JSON.
For flowSteps, capture the main user journey stages in order.
For moments, focus on frustration, bugs, and explicit feature requests.
Evidence should be short references to transcript or screenshot observations.
Suggested ticket titles should be actionable and concise when a bug or frustration clearly maps to a ticket.`;

function compactTranscript(transcript: TranscriptSegment[]) {
  return transcript
    .map(
      (segment) =>
        `[${segment.startSec.toFixed(1)}-${segment.endSec.toFixed(1)}] ${segment.text}`,
    )
    .join("\n");
}

function compactScreenshots(screenshots: ScreenshotInsight[]) {
  return screenshots
    .map((screenshot) => {
      const objects = screenshot.objects
        .map((obj) => `${obj.kind}:${obj.label}`)
        .join(", ");
      return `[${screenshot.timestampSec.toFixed(1)}] ${screenshot.caption}${
        screenshot.pageLabel ? ` | page=${screenshot.pageLabel}` : ""
      }${objects ? ` | objects=${objects}` : ""}`;
    })
    .join("\n");
}

export async function analyzeMomentsAndFlow(params: {
  transcript: TranscriptSegment[];
  screenshots: ScreenshotInsight[];
}) {
  const result = await generateJsonFromText<{
    flowSteps: FlowStep[];
    moments: Moment[];
  }>({
    responseSchema,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Transcript:\n${compactTranscript(
      params.transcript,
    )}\n\nScreenshot timeline:\n${compactScreenshots(params.screenshots)}`,
  });

  return {
    flowSteps: result.flowSteps.map((step) => flowStepSchema.parse(step)),
    moments: result.moments.map((moment) => momentSchema.parse(moment)),
  };
}
