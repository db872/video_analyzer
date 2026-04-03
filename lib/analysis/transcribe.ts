import { Type } from "@google/genai";
import {
  generateJsonFromUploadedFile,
  generateJsonFromVideoUrl,
  getGeminiTranscriptionModelName,
} from "@/lib/analysis/gemini-client";
import { splitAudioIntoChunks } from "@/lib/server/ffmpeg";
import {
  transcriptSegmentSchema,
  type TranscriptSegment,
} from "@/lib/types";

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
    },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        propertyOrdering: ["startSec", "endSec", "text"],
        properties: {
          startSec: { type: Type.NUMBER },
          endSec: { type: Type.NUMBER },
          text: { type: Type.STRING },
        },
        required: ["startSec", "endSec", "text"],
      },
    },
  },
  required: ["summary", "segments"],
};

const SYSTEM_PROMPT = `You transcribe narrated product walkthrough audio.
Return strict JSON only.
The input is audio only, not video. Do not infer anything from visuals.
Produce accurate timestamped speech segments in seconds.
All segment times must be relative to the provided audio clip, not the original full recording.
Use contiguous chronological segments that preserve speaker wording as faithfully as possible.
Prefer 3-20 second segments. Merge tiny pauses, but do not collapse large topic changes into one segment.
If something is unclear, use the best-faith transcript and avoid inventing words.`;

function getTranscriptionChunkSeconds() {
  const value = Number(process.env.TRANSCRIPTION_CHUNK_SEC ?? "120");
  return Number.isFinite(value) && value > 0 ? value : 120;
}

function roundSeconds(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizeTranscriptSegments(params: {
  offsetSec: number;
  endSec: number;
  segments: TranscriptSegment[];
}) {
  return params.segments
    .map((segment) => {
      const localStart = Math.max(0, segment.startSec);
      const localEnd = Math.max(localStart + 0.1, segment.endSec);
      const globalStart = roundSeconds(params.offsetSec + localStart);
      const globalEnd = roundSeconds(
        Math.min(params.endSec, params.offsetSec + localEnd),
      );

      return {
        startSec: globalStart,
        endSec: Math.max(globalStart + 0.1, globalEnd),
        text: segment.text.trim(),
      };
    })
    .filter((segment) => segment.text.length > 0);
}

export async function transcribeAudioChunk(params: {
  filePath: string;
  mimeType: string;
  clipStartSec: number;
  clipEndSec: number;
  chunkIndex: number;
  totalChunks: number;
}) {
  console.log("[transcribe] starting chunk", {
    chunkIndex: params.chunkIndex + 1,
    totalChunks: params.totalChunks,
    clipStartSec: params.clipStartSec,
    clipEndSec: params.clipEndSec,
  });
  const model = getGeminiTranscriptionModelName();
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await generateJsonFromUploadedFile<{
        summary: string;
        segments: TranscriptSegment[];
      }>({
        filePath: params.filePath,
        mimeType: params.mimeType,
        displayName: `pm-video-analyzer-audio-${params.chunkIndex}`,
        responseSchema,
        model,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: `Process this audio clip and produce a detailed transcription.

Requirements:
1. The clip covers ${params.clipStartSec.toFixed(2)}s to ${params.clipEndSec.toFixed(
          2,
        )}s of the original recording.
2. Return a brief summary of this clip.
3. Return timestamped speech segments using numeric seconds relative to this clip.
4. Each segment should include startSec, endSec, and text.
5. Do not use percentages, mm:ss strings, or prose outside the schema.
6. Do not add words that are not spoken.`,
      });

      return normalizeTranscriptSegments({
        offsetSec: params.clipStartSec,
        endSec: params.clipEndSec,
        segments: result.segments.map((segment) =>
          transcriptSegmentSchema.parse(segment),
        ),
      });
    } catch (error) {
      lastError = error;
      const message =
        error instanceof Error ? error.message : "Unknown transcription error";
      console.warn("[transcribe] chunk attempt failed", {
        chunkIndex: params.chunkIndex + 1,
        totalChunks: params.totalChunks,
        attempt,
        model,
        error: message,
      });

      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Transcription chunk failed");
}

export async function transcribeAudioFile(params: {
  filePath: string;
  mimeType: string;
  outputDir: string;
}) {
  const chunks = await splitAudioIntoChunks({
    audioPath: params.filePath,
    outputDir: params.outputDir,
    chunkDurationSec: getTranscriptionChunkSeconds(),
  });
  console.log("[transcribe] prepared audio chunks", {
    totalChunks: chunks.length,
    chunkDurationSec: getTranscriptionChunkSeconds(),
  });

  const transcriptChunks: Array<{ chunkIndex: number; segments: TranscriptSegment[] }> = [];

  for (const chunk of chunks) {
    const chunkSegments = await transcribeAudioChunk({
      filePath: chunk.path,
      mimeType: params.mimeType,
      clipStartSec: chunk.startSec,
      clipEndSec: chunk.endSec,
      chunkIndex: chunk.index,
      totalChunks: chunks.length,
    });

    transcriptChunks.push({
      chunkIndex: chunk.index,
      segments: chunkSegments,
    });
    console.log("[transcribe] completed chunk", {
      chunkIndex: chunk.index + 1,
      totalChunks: chunks.length,
      segmentCount: chunkSegments.length,
      transcriptSegmentsSoFar: transcriptChunks.reduce(
        (count, current) => count + current.segments.length,
        0,
      ),
    });
  }

  const transcript = mergeTranscriptChunks(transcriptChunks);
  console.log("[transcribe] transcription complete", {
    totalSegments: transcript.length,
  });
  return transcript;
}

export async function transcribeVideoUrl(params: { videoUrl: string }) {
  const result = await generateJsonFromVideoUrl<{
    summary: string;
    segments: TranscriptSegment[];
  }>({
    videoUrl: params.videoUrl,
    displayName: "pm-video-analyzer-youtube-transcript",
    responseSchema,
    model: getGeminiTranscriptionModelName(),
    systemPrompt: `You transcribe narrated product walkthrough videos from a public YouTube URL.
Return strict JSON only.
Use the video's spoken audio as the primary source and use visuals only to disambiguate obvious product nouns or labels when the speech is unclear.
Produce accurate timestamped speech segments in seconds relative to the full video.
Prefer 3-20 second segments. Merge tiny pauses, but do not collapse large topic changes into one segment.
If something is unclear, use the best-faith transcript and avoid inventing words.`,
    userPrompt: `Process this public YouTube video and produce a detailed transcription.

Requirements:
1. Return a brief summary of the full video.
2. Return timestamped speech segments using numeric seconds relative to the full video.
3. Each segment must include startSec, endSec, and text.
4. Do not use percentages, mm:ss strings, or prose outside the schema.
5. Do not add words that are not spoken.`,
  });

  return result.segments.map((segment) => transcriptSegmentSchema.parse(segment));
}

export function mergeTranscriptChunks(
  chunks: Array<{
    chunkIndex: number;
    segments: TranscriptSegment[];
  }>,
) {
  return chunks
    .slice()
    .sort((left, right) => left.chunkIndex - right.chunkIndex)
    .flatMap((chunk) => chunk.segments)
    .map((segment) => transcriptSegmentSchema.parse(segment));
}
