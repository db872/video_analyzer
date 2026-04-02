import { execFile } from "child_process";
import { mkdir } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { getFfmpegPath } from "@/lib/server/ffmpeg";
import { getYouTubeVideoId } from "@/lib/video-source";

const execFileAsync = promisify(execFile);
const PYTHON_VENDOR_PATH = join(process.cwd(), "vendor", "python");
const DEFAULT_YOUTUBE_EXTRACTOR_ARGS =
  "youtube:player_client=tv,web_safari,mweb;formats=incomplete";
const DEFAULT_USER_AGENTS: Record<string, string> = {
  chrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  chromium:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
};

function cleanYtDlpErrorMessage(message: string) {
  return message
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim().length > 0 &&
        !line.startsWith("Deprecated Feature: Support for Python version 3.9"),
    )
    .join("\n");
}

function buildHelpfulDownloadError(message: string) {
  const cleaned = cleanYtDlpErrorMessage(message);
  const blockedByYoutube =
    cleaned.includes("HTTP Error 403") ||
    cleaned.includes("The page needs to be reloaded") ||
    cleaned.includes("Sign in to confirm") ||
    cleaned.includes("not a bot");

  if (!blockedByYoutube) {
    return cleaned || "yt-dlp download failed";
  }

  return [
    "YouTube blocked the server-side download for this video.",
    "Set `YTDLP_COOKIES_FROM_BROWSER` in `.env.local` to a browser where you are currently logged into YouTube (for example `safari` or `chrome`), then restart the dev server and retry.",
    "You may also need `YTDLP_USER_AGENT` set to that browser's current user agent string if the video still fails.",
    cleaned,
  ].join("\n\n");
}

function optionalYtDlpArgs() {
  const args: string[] = [];

  const cookiesFromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (cookiesFromBrowser) {
    args.push("--cookies-from-browser", cookiesFromBrowser);
  }

  const cookiesFile = process.env.YTDLP_COOKIES_FILE?.trim();
  if (cookiesFile) {
    args.push("--cookies", cookiesFile);
  }

  const browserName = cookiesFromBrowser?.split(":")[0]?.split("+")[0]?.toLowerCase();
  const userAgent =
    process.env.YTDLP_USER_AGENT?.trim() ||
    (browserName ? DEFAULT_USER_AGENTS[browserName] : undefined);
  if (userAgent) {
    args.push("--user-agent", userAgent);
  }

  const extractorArgs =
    process.env.YTDLP_EXTRACTOR_ARGS?.trim() || DEFAULT_YOUTUBE_EXTRACTOR_ARGS;
  if (extractorArgs) {
    args.push("--extractor-args", extractorArgs);
  }

  return args;
}

function parseDownloadedFilePath(stdout: string) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const filepath = lines.at(-1);
  if (!filepath) {
    throw new Error("yt-dlp did not report a downloaded file path");
  }
  return filepath;
}

export async function materializeYouTubeVideoToTempFile(params: {
  videoUrl: string;
  outputDir: string;
}) {
  const videoId = getYouTubeVideoId(params.videoUrl) ?? "youtube-video";
  const outputTemplate = join(params.outputDir, `${videoId}.%(ext)s`);

  await mkdir(params.outputDir, { recursive: true });
  console.log("[youtube] downloading video with yt-dlp", {
    videoUrl: params.videoUrl,
    outputTemplate,
  });

  try {
    const { stdout } = await execFileAsync(
      "python3",
      [
        "-m",
        "yt_dlp",
        "--no-progress",
        "--no-warnings",
        "--ffmpeg-location",
        getFfmpegPath(),
        "--force-overwrites",
        "--no-part",
        "--merge-output-format",
        "mp4",
        "--print",
        "after_move:filepath",
        ...optionalYtDlpArgs(),
        "-f",
        "bv*[height<=1080]+ba/b",
        "-o",
        outputTemplate,
        params.videoUrl,
      ],
      {
        cwd: params.outputDir,
        env: {
          ...process.env,
          PYTHONPATH: process.env.PYTHONPATH
            ? `${PYTHON_VENDOR_PATH}:${process.env.PYTHONPATH}`
            : PYTHON_VENDOR_PATH,
        },
        maxBuffer: 1024 * 1024 * 10,
      },
    );

    return parseDownloadedFilePath(stdout);
  } catch (error) {
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    const stdout =
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      typeof error.stdout === "string"
        ? error.stdout.trim()
        : "";
    const details = stderr || stdout;
    throw new Error(buildHelpfulDownloadError(details));
  }
}
