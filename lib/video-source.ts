import type { StoredArtifact } from "@/lib/types";

type ArtifactLike = Pick<StoredArtifact, "storageBackend" | "publicUrl" | "metadata">;

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseYouTubeTimeParam(raw: string | null) {
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw);

  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match) return 0;

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

export function getYouTubeVideoId(value: string) {
  const url = parseUrl(value);
  if (!url) return null;

  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id || null;
  }

  if (!host.endsWith("youtube.com")) {
    return null;
  }

  const watchId = url.searchParams.get("v");
  if (watchId) return watchId;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") {
    return parts[1] || null;
  }

  return null;
}

export function isYouTubeUrl(value: string) {
  return Boolean(getYouTubeVideoId(value));
}

export function normalizeYouTubeUrl(value: string) {
  const videoId = getYouTubeVideoId(value);
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function buildYouTubeWatchUrl(value: string, startSec?: number) {
  const normalized = normalizeYouTubeUrl(value);
  if (!normalized) return value;
  const url = new URL(normalized);
  if (startSec && startSec > 0) {
    url.searchParams.set("t", String(Math.floor(startSec)));
  }
  return url.toString();
}

export function buildYouTubeEmbedUrl(value: string, startSec?: number) {
  const videoId = getYouTubeVideoId(value);
  if (!videoId) return value;
  const url = new URL(`https://www.youtube.com/embed/${videoId}`);
  if (startSec && startSec > 0) {
    url.searchParams.set("start", String(Math.floor(startSec)));
  }
  url.searchParams.set("rel", "0");
  return url.toString();
}

export function getYouTubeStartSeconds(value: string) {
  const url = parseUrl(value);
  if (!url) return 0;
  return Math.max(
    parseYouTubeTimeParam(url.searchParams.get("t")),
    parseYouTubeTimeParam(url.searchParams.get("start")),
  );
}

export function getVideoSourceKind(artifact: ArtifactLike) {
  if (
    artifact.storageBackend === "external" &&
    artifact.metadata.sourceType === "youtube"
  ) {
    return "youtube" as const;
  }

  if (isYouTubeUrl(artifact.publicUrl)) {
    return "youtube" as const;
  }

  return "file" as const;
}
