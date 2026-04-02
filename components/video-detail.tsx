"use client";

import type { AnalysisMode, Moment, MomentCategory, VideoDetail } from "@/lib/types";
import {
  downloadBlob,
  downloadText,
  mergeContiguousRanges,
  transcriptTextForRange,
} from "@/lib/export-clips";
import {
  buildYouTubeWatchUrl,
  getYouTubeStartSeconds,
  getYouTubeVideoId,
  getVideoSourceKind,
} from "@/lib/video-source";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

declare global {
  interface Window {
    YT?: {
      Player: new (
        element: HTMLElement,
        options: {
          videoId: string;
          playerVars?: Record<string, string | number>;
          events?: {
            onReady?: (event: { target: YouTubePlayer }) => void;
          };
        },
      ) => YouTubePlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

type YouTubePlayer = {
  destroy: () => void;
  playVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
};

const categoryLabel: Record<MomentCategory, string> = {
  frustration: "Frustration",
  bug: "Bug",
  feature_request: "Feature request",
};

const categoryClass: Record<MomentCategory, string> = {
  frustration: "text-amber-300 border-amber-500/40",
  bug: "text-red-300 border-red-500/40",
  feature_request: "text-emerald-300 border-emerald-500/40",
};

function formatTime(sec: number) {
  const total = Math.max(0, Math.floor(sec));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

export function VideoDetailView({ initialVideo }: { initialVideo: VideoDetail }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const youtubeContainerRef = useRef<HTMLDivElement>(null);
  const youtubePlayerRef = useRef<YouTubePlayer | null>(null);
  const youtubeReadyRef = useRef(false);
  const youtubePendingSeekRef = useRef<number | null>(null);
  const [video, setVideo] = useState(initialVideo);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>(
    initialVideo.analysis?.mode ?? "pm_report",
  );
  const [analysisPrompt, setAnalysisPrompt] = useState(
    initialVideo.analysis?.prompt ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [activeSeg, setActiveSeg] = useState<number | null>(null);
  const [transcriptSel, setTranscriptSel] = useState<Set<number>>(new Set());
  const [momentSel, setMomentSel] = useState<Set<number>>(new Set());
  const [momentFilter, setMomentFilter] = useState<MomentCategory | "all">("all");
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [youtubeStartSec, setYouTubeStartSec] = useState(
    getYouTubeStartSeconds(initialVideo.sourceArtifact.publicUrl),
  );

  const sourceKind = useMemo(
    () => getVideoSourceKind(video.sourceArtifact),
    [video.sourceArtifact],
  );
  const youtubeVideoId = useMemo(
    () =>
      sourceKind === "youtube"
        ? getYouTubeVideoId(video.sourceArtifact.publicUrl)
        : null,
    [sourceKind, video.sourceArtifact.publicUrl],
  );

  const filteredMoments = useMemo(
    () =>
      video.moments.filter(
        (moment) => momentFilter === "all" || moment.category === momentFilter,
      ),
    [momentFilter, video.moments],
  );

  useEffect(() => {
    if (sourceKind !== "youtube" || !youtubeVideoId || !youtubeContainerRef.current) {
      return;
    }

    let cancelled = false;
    const initialStartSec = getYouTubeStartSeconds(video.sourceArtifact.publicUrl);

    function initializePlayer() {
      if (
        cancelled ||
        !window.YT?.Player ||
        !youtubeContainerRef.current ||
        !youtubeVideoId
      ) {
        return;
      }

      youtubePlayerRef.current?.destroy();
      youtubeReadyRef.current = false;

      youtubePlayerRef.current = new window.YT.Player(youtubeContainerRef.current, {
        videoId: youtubeVideoId,
        playerVars: {
          autoplay: 0,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            youtubeReadyRef.current = true;
            const targetSec = youtubePendingSeekRef.current ?? initialStartSec;
            if (targetSec > 0) {
              event.target.seekTo(targetSec, true);
            }
          },
        },
      });
    }

    if (window.YT?.Player) {
      initializePlayer();
    } else {
      const scriptId = "youtube-iframe-api";
      if (!document.getElementById(scriptId)) {
        const script = document.createElement("script");
        script.id = scriptId;
        script.src = "https://www.youtube.com/iframe_api";
        document.body.appendChild(script);
      }

      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        initializePlayer();
      };
    }

    return () => {
      cancelled = true;
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
      youtubeReadyRef.current = false;
    };
  }, [sourceKind, youtubeVideoId, video.sourceArtifact.publicUrl]);

  useEffect(() => {
    if (sourceKind !== "youtube") return;

    youtubePendingSeekRef.current = youtubeStartSec;

    if (youtubeReadyRef.current && youtubePlayerRef.current) {
      youtubePlayerRef.current.seekTo(youtubeStartSec, true);
      youtubePlayerRef.current.playVideo();
    }
  }, [sourceKind, youtubeStartSec]);

  const onTimeUpdate = useCallback(() => {
    const current = videoRef.current;
    if (!current) return;
    const idx = video.transcript.findIndex(
      (segment) =>
        current.currentTime >= segment.startSec &&
        current.currentTime < segment.endSec,
    );
    setActiveSeg(idx >= 0 ? idx : null);
  }, [video.transcript]);

  function seek(sec: number) {
    if (sourceKind === "youtube") {
      setYouTubeStartSec(sec);
      return;
    }

    const current = videoRef.current;
    if (!current) return;
    current.currentTime = sec;
    void current.play().catch(() => {});
  }

  async function refreshVideo() {
    const response = await fetch(`/api/videos/${video.id}`);
    const data = (await response.json()) as { video?: VideoDetail; error?: string };
    if (!response.ok || !data.video) {
      throw new Error(data.error ?? "Could not refresh video");
    }
    setVideo(data.video);
    setAnalysisMode(data.video.analysis?.mode ?? "pm_report");
    setAnalysisPrompt(data.video.analysis?.prompt ?? "");
    router.refresh();
  }

  async function handleAnalyze() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/videos/${video.id}/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: analysisMode,
          prompt: analysisMode === "analyze" ? analysisPrompt : undefined,
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Analysis failed");
      }
      await refreshVideo();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  }

  function toggleTranscript(index: number) {
    setTranscriptSel((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleMoment(index: number) {
    setMomentSel((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function runExport() {
    if (video.transcript.length === 0) return;

    setExporting(true);
    setError(null);

    try {
      const ranges: { startSec: number; endSec: number }[] = [];

      transcriptSel.forEach((index) => {
        const segment = video.transcript[index];
        if (segment) {
          ranges.push({ startSec: segment.startSec, endSec: segment.endSec });
        }
      });

      momentSel.forEach((index) => {
        const moment = video.moments[index];
        if (moment) {
          ranges.push({ startSec: moment.startSec, endSec: moment.endSec });
        }
      });

      if (ranges.length === 0) {
        throw new Error("Select at least one transcript line or moment to export.");
      }

      const merged = mergeContiguousRanges(ranges);
      for (const [index, range] of merged.entries()) {
        const response = await fetch(`/api/videos/${video.id}/export`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            startSec: range.startSec,
            endSec: range.endSec,
          }),
        });
        if (!response.ok) {
          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("application/json")) {
            const data = (await response.json()) as { error?: string };
            throw new Error(data.error ?? "Clip export failed");
          }
          throw new Error("Clip export failed");
        }

        const clip = await response.blob();
        const transcriptText = transcriptTextForRange(
          video.transcript,
          range.startSec,
          range.endSec,
        );
        const label = String(index + 1).padStart(3, "0");
        downloadBlob(clip, `${video.title}-clip-${label}.mp4`);
        downloadText(transcriptText, `${video.title}-clip-${label}.txt`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link href="/" className="text-sm text-[var(--accent)] hover:underline">
              Back to dashboard
            </Link>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              {video.title}
            </h1>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Status: {video.status}
              {video.analysis
                ? ` · latest run ${video.analysis.status} (${video.analysis.mode})`
                : " · no runs yet"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void runExport()}
              disabled={
                sourceKind === "youtube" ||
                exporting || (transcriptSel.size === 0 && momentSel.size === 0)
              }
              className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm hover:border-[var(--accent)] disabled:opacity-50"
            >
              {sourceKind === "youtube"
                ? "Clip export unavailable"
                : exporting
                  ? "Exporting..."
                  : "Export selected clips"}
            </button>
          </div>
        </div>
        <div className="grid gap-4 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 lg:grid-cols-[220px_1fr_auto]">
          <label className="flex flex-col gap-2 text-sm">
            <span className="text-[var(--muted)]">Mode</span>
            <select
              value={analysisMode}
              onChange={(event) => setAnalysisMode(event.target.value as AnalysisMode)}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 outline-none focus:border-[var(--accent)]"
            >
              <option value="pm_report">PM report</option>
              <option value="analyze">Analyze</option>
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm">
            <span className="text-[var(--muted)]">
              {analysisMode === "analyze" ? "Analyze prompt" : "Mode details"}
            </span>
            {analysisMode === "analyze" ? (
              <textarea
                value={analysisPrompt}
                onChange={(event) => setAnalysisPrompt(event.target.value)}
                placeholder="Example: Capture onboarding friction, confusing UI states, and any moments worth saving for design review."
                rows={3}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 outline-none focus:border-[var(--accent)]"
              />
            ) : (
              <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--muted)]">
                PM report mode generates transcript-based moments, tickets, timeline,
                and object model reports.
              </p>
            )}
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => void handleAnalyze()}
              disabled={loading || (analysisMode === "analyze" && !analysisPrompt.trim())}
              className="rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-medium text-[var(--bg)] disabled:opacity-50"
            >
              {loading
                ? "Analyzing..."
                : analysisMode === "analyze"
                  ? "Run analyze mode"
                  : "Run PM report"}
            </button>
          </div>
        </div>
        {video.analysis?.mode === "analyze" && video.analysis.prompt ? (
          <p className="text-sm text-[var(--muted)]">
            Latest analyze prompt: {video.analysis.prompt}
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-red-300" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="space-y-4">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h2 className="text-lg font-medium">Source video</h2>
            {sourceKind === "youtube" && youtubeVideoId ? (
              <>
                <div className="mt-4 aspect-video overflow-hidden rounded-xl border border-[var(--border)] bg-black">
                  <div ref={youtubeContainerRef} className="h-full w-full" />
                </div>
                <p className="mt-3 text-xs text-[var(--muted)]">
                  Transcript and moment clicks jump the embed to the selected timestamp.{" "}
                  <a
                    href={buildYouTubeWatchUrl(video.sourceArtifact.publicUrl, youtubeStartSec)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--accent)] hover:underline"
                  >
                    Open on YouTube
                  </a>
                </p>
              </>
            ) : (
              <video
                ref={videoRef}
                src={video.sourceArtifact.publicUrl}
                controls
                onTimeUpdate={onTimeUpdate}
                className="mt-4 w-full rounded-xl border border-[var(--border)] bg-black"
              />
            )}
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-medium">Transcript</h2>
              <p className="text-xs text-[var(--muted)]">
                {video.transcript.length} segments
              </p>
            </div>
            {video.transcript.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--muted)]">
                Run analysis to generate the boosted-audio transcript.
              </p>
            ) : (
              <ul className="mt-4 max-h-[32rem] divide-y divide-[var(--border)] overflow-y-auto rounded-xl border border-[var(--border)]">
                {video.transcript.map((segment, index) => (
                  <li key={`${segment.startSec}-${segment.endSec}-${index}`}>
                    <button
                      type="button"
                      onClick={() => seek(segment.startSec)}
                      className={`flex w-full gap-3 px-3 py-2 text-left text-sm ${
                        activeSeg === index ? "bg-[var(--accent)]/15" : "hover:bg-white/5"
                      }`}
                    >
                      <span
                        className="pt-0.5"
                        role="presentation"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleTranscript(index);
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={transcriptSel.has(index)}
                          onChange={() => toggleTranscript(index)}
                          onClick={(event) => event.stopPropagation()}
                        />
                      </span>
                      <span className="shrink-0 font-mono text-xs text-[var(--muted)]">
                        {formatTime(segment.startSec)}-{formatTime(segment.endSec)}
                      </span>
                      <span>{segment.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="space-y-4">
          {video.analysis?.mode === "analyze" ? (
            <NotesPanel screenshots={video.screenshots} onSeek={seek} />
          ) : (
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-medium">Moments</h2>
                {(["all", "frustration", "bug", "feature_request"] as const).map(
                  (value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setMomentFilter(value)}
                      className={`rounded-full border px-2.5 py-0.5 text-xs ${
                        momentFilter === value
                          ? "border-[var(--accent)] text-[var(--accent)]"
                          : "border-[var(--border)] text-[var(--muted)]"
                      }`}
                    >
                      {value === "all" ? "All" : categoryLabel[value]}
                    </button>
                  ),
                )}
              </div>
              <div className="mt-4 space-y-3">
                {filteredMoments.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No moments yet.</p>
                ) : (
                  filteredMoments.map((moment) => {
                    const index = video.moments.findIndex(
                      (candidate) =>
                        candidate.startSec === moment.startSec &&
                        candidate.title === moment.title,
                    );
                    return (
                      <MomentCard
                        key={`${moment.startSec}-${moment.title}`}
                        moment={moment}
                        selected={momentSel.has(index)}
                        onToggle={() => toggleMoment(index)}
                        onSeek={() => seek(moment.startSec)}
                      />
                    );
                  })
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      {video.analysis?.mode === "analyze" ? (
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-medium">Analyze summary</h2>
            <a
              href={`/api/videos/${video.id}/reports/timelineReport`}
              className="text-xs text-[var(--accent)] hover:underline"
            >
              JSON
            </a>
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {video.reports.timelineReport?.summary ?? "No analyze summary generated yet."}
          </p>
          <div className="mt-4 space-y-2">
            {video.reports.timelineReport?.highlights.length ? (
              video.reports.timelineReport.highlights.map((highlight) => (
                <p key={highlight} className="text-sm text-[var(--muted)]">
                  {highlight}
                </p>
              ))
            ) : (
              <p className="text-sm text-[var(--muted)]">No note highlights yet.</p>
            )}
          </div>
        </section>
      ) : (
        <div className="grid gap-6 xl:grid-cols-3">
          <ReportPanel
            title="Bug ticket report"
            summary={video.reports.bugReport?.summary ?? "No report generated yet."}
            exportBaseUrl={`/api/videos/${video.id}/reports/bugReport`}
            items={
              video.reports.bugReport?.tickets.map((ticket) => (
                <div key={ticket.title} className="space-y-2">
                  <p className="font-medium">
                    {ticket.title} · {ticket.severity}
                  </p>
                  <p className="text-sm text-[var(--muted)]">{ticket.summary}</p>
                  <p className="text-xs text-[var(--muted)]">
                    {ticket.reproductionContext}
                  </p>
                </div>
              )) ?? []
            }
          />

          <ReportPanel
            title="Timeline report"
            summary={
              video.reports.timelineReport?.summary ?? "No timeline report generated yet."
            }
            exportBaseUrl={`/api/videos/${video.id}/reports/timelineReport`}
            items={
              video.reports.timelineReport?.highlights.map((highlight) => (
                <p key={highlight} className="text-sm text-[var(--muted)]">
                  {highlight}
                </p>
              )) ?? []
            }
          />

          <ReportPanel
            title="Object model report"
            summary={
              video.reports.objectModelReport?.summary ??
              "No object model report generated yet."
            }
            exportBaseUrl={`/api/videos/${video.id}/reports/objectModelReport`}
            items={[
              <div key="entities" className="space-y-2">
                {video.entities.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No entities detected.</p>
                ) : (
                  video.entities.map((entity) => (
                    <p key={`${entity.entityType}-${entity.name}`} className="text-sm">
                      <span className="font-medium">{entity.name}</span>{" "}
                      <span className="text-[var(--muted)]">({entity.entityType})</span>
                    </p>
                  ))
                )}
              </div>,
            ]}
          />
        </div>
      )}

    </div>
  );
}

function NotesPanel({
  screenshots,
  onSeek,
}: {
  screenshots: VideoDetail["screenshots"];
  onSeek: (sec: number) => void;
}) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Notes & snapshots</h2>
        <p className="text-xs text-[var(--muted)]">{screenshots.length} saved points</p>
      </div>
      <div className="mt-4 space-y-4">
        {screenshots.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No notes or snapshots yet.</p>
        ) : (
          screenshots.map((shot) => (
            <article
              key={`${shot.timestampSec}-${shot.caption}`}
              className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)]"
            >
              {shot.imageUrl ? (
                <button type="button" onClick={() => onSeek(shot.timestampSec)} className="block w-full">
                  <Image
                    src={shot.imageUrl}
                    alt={shot.caption}
                    width={1600}
                    height={900}
                    className="aspect-video w-full object-cover"
                  />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onSeek(shot.timestampSec)}
                  className="flex aspect-video w-full items-center justify-center bg-black/30 text-sm text-[var(--muted)]"
                >
                  Jump to {formatTime(shot.timestampSec)}
                </button>
              )}
              <div className="space-y-2 p-3">
                <button
                  type="button"
                  onClick={() => onSeek(shot.timestampSec)}
                  className="text-left font-medium hover:text-[var(--accent)]"
                >
                  {formatTime(shot.timestampSec)} · {shot.pageLabel ?? "Interesting point"}
                </button>
                <p className="text-sm">{shot.caption}</p>
                {shot.rawNotes ? (
                  <p className="text-sm text-[var(--muted)] whitespace-pre-wrap">
                    {shot.rawNotes}
                  </p>
                ) : null}
                {shot.objects.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {shot.objects.map((object, index) => (
                      <span
                        key={`${shot.timestampSec}-${object.label}-${index}`}
                        className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]"
                      >
                        {object.label}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function ReportPanel({
  title,
  summary,
  items,
  exportBaseUrl,
}: {
  title: string;
  summary: string;
  items: React.ReactNode[];
  exportBaseUrl: string;
}) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-medium">{title}</h2>
        <div className="flex gap-3 text-xs">
          <a href={exportBaseUrl} className="text-[var(--accent)] hover:underline">
            JSON
          </a>
          <a
            href={`${exportBaseUrl}?format=html`}
            className="text-[var(--accent)] hover:underline"
          >
            HTML
          </a>
        </div>
      </div>
      <p className="mt-2 text-sm text-[var(--muted)]">{summary}</p>
      <div className="mt-4 space-y-3">
        {items.length > 0 ? items : <p className="text-sm text-[var(--muted)]">No data yet.</p>}
      </div>
    </section>
  );
}

function MomentCard({
  moment,
  selected,
  onToggle,
  onSeek,
}: {
  moment: Moment;
  selected: boolean;
  onToggle: () => void;
  onSeek: () => void;
}) {
  return (
    <article
      className={`rounded-xl border-l-2 bg-[var(--bg)] p-3 ${categoryClass[moment.category]}`}
    >
      <div className="flex gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="mt-1 shrink-0"
        />
        <div className="space-y-2">
          <button
            type="button"
            onClick={onSeek}
            className="text-left font-medium hover:underline"
          >
            {moment.title}
          </button>
          <p className="text-xs text-[var(--muted)]">
            {formatTime(moment.startSec)}-{formatTime(moment.endSec)} ·{" "}
            {categoryLabel[moment.category]} · {moment.severity}
          </p>
          <p className="text-sm text-[var(--text)]">{moment.summary}</p>
          {moment.quote ? (
            <p className="text-xs italic text-[var(--muted)]">
              &quot;{moment.quote}&quot;
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
}
