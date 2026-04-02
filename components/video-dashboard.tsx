"use client";

import type { VideoListItem } from "@/lib/types";
import { getVideoSourceKind } from "@/lib/video-source";
import { upload } from "@vercel/blob/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

type Props = {
  initialVideos: VideoListItem[];
  databaseReady: boolean;
  blobUploadAvailable: boolean;
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function VideoDashboard({
  initialVideos,
  databaseReady,
  blobUploadAvailable,
}: Props) {
  const router = useRouter();
  const [videos, setVideos] = useState(initialVideos);
  const [sourceMode, setSourceMode] = useState<"upload" | "youtube">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYouTubeUrl] = useState("");
  const [title, setTitle] = useState("");
  const [useBlob, setUseBlob] = useState(blobUploadAvailable);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workingVideoId, setWorkingVideoId] = useState<string | null>(null);

  const totalVideos = useMemo(() => videos.length, [videos]);

  async function refreshVideos() {
    const response = await fetch("/api/videos");
    const data = (await response.json()) as { videos?: VideoListItem[]; error?: string };
    if (!response.ok) {
      throw new Error(data.error ?? "Could not refresh videos");
    }
    setVideos(data.videos ?? []);
    router.refresh();
  }

  async function handleCreate() {
    setSaving(true);
    setError(null);

    try {
      let response: Response;

      if (sourceMode === "youtube") {
        response = await fetch("/api/videos", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: title || undefined,
            youtubeUrl: youtubeUrl.trim(),
          }),
        });
      } else {
        if (!file) return;

        if (blobUploadAvailable && useBlob) {
          const blob = await upload(file.name, file, {
            access: "public",
            handleUploadUrl: "/api/blob",
            multipart: file.size > 45 * 1024 * 1024,
          });

          response = await fetch("/api/videos", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              title: title || file.name.replace(/\.[^.]+$/, ""),
              blobUrl: blob.url,
              storageKey: blob.pathname,
              mimeType: blob.contentType || file.type || "video/mp4",
              sizeBytes: file.size,
              originalFilename: file.name,
            }),
          });
        } else {
          const formData = new FormData();
          formData.append("file", file);
          if (title.trim()) {
            formData.append("title", title.trim());
          }

          response = await fetch("/api/videos", {
            method: "POST",
            body: formData,
          });
        }
      }

      const data = (await response.json()) as {
        video?: VideoListItem;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "Could not create video");
      }

      setFile(null);
      setYouTubeUrl("");
      setTitle("");
      await refreshVideos();
      if (data.video?.id) {
        router.push(`/videos/${data.video.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create video");
    } finally {
      setSaving(false);
    }
  }

  async function handleAnalyze(videoId: string) {
    setWorkingVideoId(videoId);
    setError(null);

    try {
      const response = await fetch(`/api/videos/${videoId}/analyze`, {
        method: "POST",
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Analysis failed");
      }
      await refreshVideos();
      router.push(`/videos/${videoId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setWorkingVideoId(null);
    }
  }

  async function handleDelete(videoId: string) {
    if (!window.confirm("Delete this video and all derived artifacts?")) {
      return;
    }

    setWorkingVideoId(videoId);
    setError(null);

    try {
      const response = await fetch(`/api/videos/${videoId}`, {
        method: "DELETE",
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Delete failed");
      }
      await refreshVideos();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setWorkingVideoId(null);
    }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.24em] text-[var(--muted)]">
              Video workspace
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              PM Video Analyzer
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">
              Persist videos, build reusable memory from transcript and screenshots,
              and generate detailed bug and object-model reports from narrated app
              walkthroughs.
            </p>
          </div>
          <div className="rounded-xl border border-[var(--border)] px-4 py-3 text-sm text-[var(--muted)]">
            {totalVideos} video{totalVideos === 1 ? "" : "s"}
          </div>
        </div>
      </section>

      {!databaseReady ? (
        <section className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-5 text-sm text-amber-100">
          <p className="font-medium">Database setup required</p>
          <p className="mt-2 text-amber-100/80">
            Add `DATABASE_URL` to `.env.local` using a Neon Postgres connection
            string, then refresh the page. The rest of the stack is wired to store
            videos, artifacts, memory, and reports once the database is available.
          </p>
        </section>
      ) : null}

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h2 className="text-lg font-medium">Create video</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSourceMode("upload")}
            className={`rounded-full border px-3 py-1 text-sm ${
              sourceMode === "upload"
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--muted)]"
            }`}
          >
            Upload file
          </button>
          <button
            type="button"
            onClick={() => setSourceMode("youtube")}
            className={`rounded-full border px-3 py-1 text-sm ${
              sourceMode === "youtube"
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--muted)]"
            }`}
          >
            YouTube URL
          </button>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_1fr_auto]">
          {sourceMode === "upload" ? (
            <label className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg)] px-4 py-8 text-center text-sm text-[var(--muted)] hover:border-[var(--accent)]">
              <input
                type="file"
                className="hidden"
                accept="video/*"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              {file
                ? `${file.name} (${formatBytes(file.size)})`
                : "Choose a walkthrough video"}
            </label>
          ) : (
            <label className="flex flex-col gap-2 text-sm">
              <span className="text-[var(--muted)]">YouTube URL</span>
              <input
                value={youtubeUrl}
                onChange={(event) => setYouTubeUrl(event.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 outline-none ring-0 focus:border-[var(--accent)]"
              />
              <span className="text-xs text-[var(--muted)]">
                Public YouTube videos can be analyzed directly by Gemini.
              </span>
            </label>
          )}
          <label className="flex flex-col gap-2 text-sm">
            <span className="text-[var(--muted)]">Title</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Optional display title"
              className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 outline-none ring-0 focus:border-[var(--accent)]"
            />
            {blobUploadAvailable && sourceMode === "upload" ? (
              <label className="mt-2 flex items-center gap-2 text-xs text-[var(--muted)]">
                <input
                  type="checkbox"
                  checked={useBlob}
                  onChange={(event) => setUseBlob(event.target.checked)}
                />
                Use Vercel Blob direct upload when available
              </label>
            ) : null}
          </label>
          <button
            type="button"
            disabled={
              !databaseReady ||
              saving ||
              (sourceMode === "upload" ? !file : youtubeUrl.trim().length === 0)
            }
            onClick={() => void handleCreate()}
            className="rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-medium text-[var(--bg)] disabled:opacity-40"
          >
            {saving ? "Saving..." : "Create video"}
          </button>
        </div>
        {error ? (
          <p className="mt-3 text-sm text-red-300" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-medium">Saved videos</h2>
          <button
            type="button"
            onClick={() => void refreshVideos()}
            className="text-sm text-[var(--accent)] hover:underline"
          >
            Refresh
          </button>
        </div>

        {videos.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--muted)]">
            No videos yet. Upload a narrated screen recording or paste a YouTube
            walkthrough link to create the first workspace entry.
          </p>
        ) : (
          <div className="mt-4 grid gap-4">
            {videos.map((video) => (
              <article
                key={video.id}
                className="rounded-2xl border border-[var(--border)] bg-[var(--bg)] p-4"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/videos/${video.id}`}
                        className="text-lg font-medium hover:text-[var(--accent)]"
                      >
                        {video.title}
                      </Link>
                      <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs uppercase tracking-wide text-[var(--muted)]">
                        {video.status}
                      </span>
                      {video.latestRun ? (
                        <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs uppercase tracking-wide text-[var(--muted)]">
                          latest run: {video.latestRun.status} · {video.latestRun.mode}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm text-[var(--muted)]">
                      {getVideoSourceKind(video.sourceArtifact) === "youtube"
                        ? "YouTube link"
                        : formatBytes(video.sourceArtifact.sizeBytes)}{" "}
                      · created{" "}
                      {new Date(video.createdAt).toLocaleString()}
                    </p>
                    <div className="flex flex-wrap gap-2 text-xs text-[var(--muted)]">
                      <span>{video.counts.transcriptSegments} transcript segments</span>
                      <span>{video.counts.screenshots} screenshots</span>
                      <span>{video.counts.moments} moments</span>
                      <span>{video.counts.entities} modeled objects</span>
                    </div>
                    {video.latestRun?.error ? (
                      <p className="text-sm text-red-300">{video.latestRun.error}</p>
                    ) : null}
                    <p className="text-xs text-[var(--muted)]">
                      Open the video detail page to run prompt-driven Analyze mode.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleAnalyze(video.id)}
                      disabled={workingVideoId === video.id}
                      className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm hover:border-[var(--accent)] disabled:opacity-50"
                    >
                      {workingVideoId === video.id ? "Working..." : "Analyze"}
                    </button>
                    <Link
                      href={`/videos/${video.id}`}
                      className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm hover:border-[var(--accent)]"
                    >
                      Open
                    </Link>
                    <button
                      type="button"
                      onClick={() => void handleDelete(video.id)}
                      disabled={workingVideoId === video.id}
                      className="rounded-xl border border-red-500/40 px-3 py-2 text-sm text-red-200 hover:border-red-400 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
