import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { TranscriptSegment } from "@/lib/types";

const CORE_VERSION = "0.12.6";

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) {
    return ffmpegInstance;
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      const ffmpeg = new FFmpeg();
      const base = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
      await ffmpeg.load({
        coreURL: await toBlobURL(
          `${base}/ffmpeg-core.js`,
          "text/javascript",
        ),
        wasmURL: await toBlobURL(
          `${base}/ffmpeg-core.wasm`,
          "application/wasm",
        ),
      });
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })();
  }
  return loadPromise;
}

export function mergeContiguousRanges(
  ranges: { startSec: number; endSec: number }[],
): { startSec: number; endSec: number }[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.startSec - b.startSec);
  const out: { startSec: number; endSec: number }[] = [];
  let cur = { ...sorted[0]! };
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]!;
    if (r.startSec <= cur.endSec + 0.25) {
      cur.endSec = Math.max(cur.endSec, r.endSec);
    } else {
      out.push(cur);
      cur = { ...r };
    }
  }
  out.push(cur);
  return out;
}

export function transcriptTextForRange(
  transcript: TranscriptSegment[],
  startSec: number,
  endSec: number,
): string {
  const lines = transcript
    .filter((s) => s.endSec > startSec && s.startSec < endSec)
    .map((s) => s.text.trim())
    .filter(Boolean);
  return lines.join("\n\n");
}

export async function exportVideoClip(params: {
  videoFile: File;
  startSec: number;
  endSec: number;
  padSec?: number;
}): Promise<Blob> {
  const pad = params.padSec ?? 0.5;
  const start = Math.max(0, params.startSec - pad);
  const end = Math.max(start + 0.25, params.endSec + pad);
  const duration = end - start;

  const ffmpeg = await getFFmpeg();
  const inName = "input.bin";
  const outName = "out.mp4";

  await ffmpeg.writeFile(inName, await fetchFile(params.videoFile));

  let code = await ffmpeg.exec([
    "-ss",
    String(start),
    "-i",
    inName,
    "-t",
    String(duration),
    "-c",
    "copy",
    "-movflags",
    "frag_keyframe+empty_moov",
    outName,
  ]);

  if (code !== 0) {
    code = await ffmpeg.exec([
      "-ss",
      String(start),
      "-i",
      inName,
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "frag_keyframe+empty_moov",
      outName,
    ]);
  }

  if (code !== 0) {
    await ffmpeg.deleteFile(inName).catch(() => {});
    await ffmpeg.deleteFile(outName).catch(() => {});
    throw new Error("ffmpeg could not create this clip (try a different range)");
  }

  const data = await ffmpeg.readFile(outName);
  await ffmpeg.deleteFile(inName).catch(() => {});
  await ffmpeg.deleteFile(outName).catch(() => {});

  if (typeof data === "string") {
    throw new Error("Unexpected text output from ffmpeg");
  }
  const copy = new Uint8Array(data);
  return new Blob([copy], { type: "video/mp4" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadText(text: string, filename: string) {
  downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), filename);
}
