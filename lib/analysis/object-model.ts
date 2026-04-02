import { Type } from "@google/genai";
import type { ClipFinding } from "@/lib/analysis/clip-understanding";
import { normalizeConfidence } from "@/lib/analysis/normalize-confidence";
import {
  memoryEntitySchema,
  memoryRelationshipSchema,
  type MemoryEntity,
  type MemoryRelationship,
  type TranscriptSegment,
} from "@/lib/types";
import { generateJsonFromText } from "@/lib/analysis/gemini-client";

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    entities: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        propertyOrdering: [
          "entityType",
          "name",
          "description",
          "confidence",
          "firstSeenSec",
          "lastSeenSec",
          "sourceEvidence",
        ],
        properties: {
          entityType: { type: Type.STRING },
          name: { type: Type.STRING },
          description: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
          firstSeenSec: { type: Type.NUMBER, nullable: true },
          lastSeenSec: { type: Type.NUMBER, nullable: true },
          sourceEvidence: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ["entityType", "name", "description", "confidence", "sourceEvidence"],
      },
    },
    relationships: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        propertyOrdering: [
          "fromEntity",
          "toEntity",
          "relationshipType",
          "description",
          "confidence",
        ],
        properties: {
          fromEntity: { type: Type.STRING },
          toEntity: { type: Type.STRING },
          relationshipType: { type: Type.STRING },
          description: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
        },
        required: [
          "fromEntity",
          "toEntity",
          "relationshipType",
          "description",
          "confidence",
        ],
      },
    },
  },
  required: ["entities", "relationships"],
};

const SYSTEM_PROMPT = `You build a reusable memory model for product walkthrough videos.
Use transcript cues and targeted clip findings to infer stable UI and business-domain objects.
Return strict JSON only.
Entity names should be stable, deduplicated labels.
Entity types can include page, view, workflow, object, record, table, filter, form, action, report, or status.
Relationships should describe how objects connect from the user's perspective.
All confidence values must be decimals from 0 to 1, not percentages.`;

function compactTranscript(transcript: TranscriptSegment[]) {
  return transcript
    .map(
      (segment) =>
        `[${segment.startSec.toFixed(1)}-${segment.endSec.toFixed(1)}] ${segment.text}`,
    )
    .join("\n");
}

function compactClipFindings(clipFindings: ClipFinding[]) {
  return clipFindings
    .map((clip) => {
      const visibleObjects = clip.visibleObjects.join(", ");
      const objectHints = clip.objectHints.join(", ");
      return `[${clip.startSec.toFixed(1)}-${clip.endSec.toFixed(1)}] ${clip.title} | ${
        clip.summary
      }${visibleObjects ? ` | visible=${visibleObjects}` : ""}${
        objectHints ? ` | objectHints=${objectHints}` : ""
      }`;
    })
    .join("\n");
}

export async function buildObjectModel(params: {
  transcript: TranscriptSegment[];
  clipFindings: ClipFinding[];
}) {
  const result = await generateJsonFromText<{
    entities: MemoryEntity[];
    relationships: MemoryRelationship[];
  }>({
    responseSchema,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Transcript:\n${compactTranscript(
      params.transcript,
    )}\n\nTargeted clip findings:\n${compactClipFindings(params.clipFindings)}`,
  });

  return {
    entities: result.entities.map((entity) =>
      memoryEntitySchema.parse({
        ...entity,
        confidence: normalizeConfidence(entity.confidence),
      }),
    ),
    relationships: result.relationships.map((relationship) =>
      memoryRelationshipSchema.parse({
        ...relationship,
        confidence: normalizeConfidence(relationship.confidence),
      }),
    ),
  };
}
