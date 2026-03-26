import { execFile } from "child_process";
import { mkdtemp, readdir } from "fs/promises";
import { createRequire } from "module";
import { promisify } from "util";
import { tmpdir } from "os";
import { dirname, join } from "path";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

function getFfmpegPath() {
  const modulePath = require.resolve("ffmpeg-static");
  return join(dirname(modulePath), "ffmpeg");
}

async function runFfmpeg(args: string[]) {
  try {
    await execFileAsync(getFfmpegPath(), args, {
      maxBuffer: 1024 * 1024 * 10,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "ffmpeg command failed";
    throw new Error(message);
  }
}

function parseDurationSeconds(stderr: string) {
  const match = stderr.match(/Duration:\s+(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) {
    throw new Error("Could not determine media duration from ffmpeg output.");
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return hours * 3600 + minutes * 60 + seconds;
}

async function getMediaDurationSeconds(path: string) {
  try {
    await execFileAsync(getFfmpegPath(), ["-i", path], {
      maxBuffer: 1024 * 1024 * 10,
    });
    throw new Error("ffmpeg did not emit duration information.");
  } catch (error) {
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr
        : "";

    if (!stderr) {
      throw new Error("ffmpeg could not inspect media duration.");
    }

    return parseDurationSeconds(stderr);
  }
}

export async function createWorkingDir(prefix: string) {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

export async function extractBoostedAudio(params: {
  videoPath: string;
  outputDir: string;
  gainMultiplier?: number;
}) {
  const outputPath = join(params.outputDir, "boosted-audio.wav");
  const gain = params.gainMultiplier ?? 1;
  const audioFilter =
    gain === 1 ? "loudnorm" : `loudnorm,volume=${gain.toFixed(2)}`;

  console.log("[ffmpeg] extracting boosted audio", {
    videoPath: params.videoPath,
    outputPath,
    audioFilter,
  });

  await runFfmpeg([
    "-y",
    "-i",
    params.videoPath,
    "-vn",
    "-af",
    audioFilter,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ]);

  return outputPath;
}

export async function splitAudioIntoChunks(params: {
  audioPath: string;
  outputDir: string;
  chunkDurationSec: number;
}) {
  const durationSec = await getMediaDurationSeconds(params.audioPath);
  console.log("[ffmpeg] splitting audio into chunks", {
    audioPath: params.audioPath,
    durationSec,
    chunkDurationSec: params.chunkDurationSec,
  });
  const chunks: Array<{
    index: number;
    path: string;
    startSec: number;
    endSec: number;
  }> = [];

  let index = 0;
  for (
    let startSec = 0;
    startSec < durationSec;
    startSec += params.chunkDurationSec
  ) {
    const remaining = durationSec - startSec;
    const chunkLength = Math.min(params.chunkDurationSec, remaining);
    const outputPath = join(
      params.outputDir,
      `audio-chunk-${String(index).padStart(3, "0")}.wav`,
    );

    await runFfmpeg([
      "-y",
      "-ss",
      startSec.toFixed(3),
      "-t",
      chunkLength.toFixed(3),
      "-i",
      params.audioPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ]);

    chunks.push({
      index,
      path: outputPath,
      startSec,
      endSec: startSec + chunkLength,
    });
    console.log("[ffmpeg] created audio chunk", {
      chunkIndex: index,
      startSec,
      endSec: startSec + chunkLength,
      outputPath,
    });
    index += 1;
  }

  console.log("[ffmpeg] finished audio chunking", {
    totalChunks: chunks.length,
  });
  return chunks;
}

export async function extractScreenshots(params: {
  videoPath: string;
  outputDir: string;
  intervalSec: number;
  maxFrames: number;
}) {
  const pattern = join(params.outputDir, "frame-%03d.jpg");
  console.log("[ffmpeg] extracting screenshots", {
    videoPath: params.videoPath,
    intervalSec: params.intervalSec,
    maxFrames: params.maxFrames,
  });

  await runFfmpeg([
    "-y",
    "-i",
    params.videoPath,
    "-vf",
    `fps=1/${params.intervalSec},scale='min(1440,iw)':-1`,
    "-frames:v",
    String(params.maxFrames),
    pattern,
  ]);

  const files = (await readdir(params.outputDir))
    .filter((name) => name.startsWith("frame-") && name.endsWith(".jpg"))
    .sort();

  console.log("[ffmpeg] extracted screenshots", {
    count: files.length,
  });

  return files.map((name, index) => ({
    filename: name,
    path: join(params.outputDir, name),
    timestampSec: index * params.intervalSec,
  }));
}
