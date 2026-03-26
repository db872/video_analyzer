"use client";

import type { Moment, MomentCategory, VideoDetail } from "@/lib/types";
import {
  downloadBlob,
  downloadText,
  exportVideoClip,
  getFFmpeg,
  mergeContiguousRanges,
  transcriptTextForRange,
} from "@/lib/export-clips";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";

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
  const [video, setVideo] = useState(initialVideo);
  const [error, setError] = useState<string | null>(null);
  const [activeSeg, setActiveSeg] = useState<number | null>(null);
  const [transcriptSel, setTranscriptSel] = useState<Set<number>>(new Set());
  const [momentSel, setMomentSel] = useState<Set<number>>(new Set());
  const [momentFilter, setMomentFilter] = useState<MomentCategory | "all">("all");
  const [loading, setLoading] = useState(false);
  const [ffmpegReady, setFfmpegReady] = useState(false);
  const [exporting, setExporting] = useState(false);

  const filteredMoments = useMemo(
    () =>
      video.moments.filter(
        (moment) => momentFilter === "all" || moment.category === momentFilter,
      ),
    [momentFilter, video.moments],
  );

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
    router.refresh();
  }

  async function handleAnalyze() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/videos/${video.id}/analyze`, {
        method: "POST",
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

  async function loadSourceFile() {
    const response = await fetch(video.sourceArtifact.publicUrl);
    if (!response.ok) {
      throw new Error("Could not load source video for export");
    }
    const blob = await response.blob();
    return new File([blob], video.title, { type: blob.type || "video/mp4" });
  }

  async function runExport() {
    if (video.transcript.length === 0) return;

    setExporting(true);
    setError(null);

    try {
      if (!ffmpegReady) {
        await getFFmpeg();
        setFfmpegReady(true);
      }

      const sourceFile = await loadSourceFile();
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
        const clip = await exportVideoClip({
          videoFile: sourceFile,
          startSec: range.startSec,
          endSec: range.endSec,
        });
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
              {video.analysis ? ` · latest run ${video.analysis.status}` : " · no runs yet"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleAnalyze()}
              disabled={loading}
              className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg)] disabled:opacity-50"
            >
              {loading ? "Analyzing..." : "Run analysis"}
            </button>
            <button
              type="button"
              onClick={() => void getFFmpeg().then(() => setFfmpegReady(true))}
              className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm hover:border-[var(--accent)]"
            >
              {ffmpegReady ? "ffmpeg ready" : "Load ffmpeg"}
            </button>
            <button
              type="button"
              onClick={() => void runExport()}
              disabled={
                exporting || (transcriptSel.size === 0 && momentSel.size === 0)
              }
              className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm hover:border-[var(--accent)] disabled:opacity-50"
            >
              {exporting ? "Exporting..." : "Export selected clips"}
            </button>
          </div>
        </div>
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
            <video
              ref={videoRef}
              src={video.sourceArtifact.publicUrl}
              controls
              onTimeUpdate={onTimeUpdate}
              className="mt-4 w-full rounded-xl border border-[var(--border)] bg-black"
            />
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

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-medium">Screenshot memory</h2>
              <span className="text-xs text-[var(--muted)]">
                {video.screenshots.length} frames
              </span>
            </div>
            {video.screenshots.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--muted)]">
                Screenshot sampling appears here after analysis.
              </p>
            ) : (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {video.screenshots.map((screenshot) => (
                  <article
                    key={screenshot.id ?? `${screenshot.timestampSec}-${screenshot.caption}`}
                    className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)]"
                  >
                    {screenshot.imageUrl ? (
                      <Image
                        loader={({ src }) => src}
                        src={screenshot.imageUrl}
                        alt={screenshot.caption}
                        width={1280}
                        height={720}
                        unoptimized
                        className="aspect-video w-full object-cover"
                      />
                    ) : null}
                    <div className="space-y-2 p-3">
                      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
                        {formatTime(screenshot.timestampSec)}
                        {screenshot.pageLabel ? ` · ${screenshot.pageLabel}` : ""}
                      </p>
                      <p className="text-sm">{screenshot.caption}</p>
                      {screenshot.objects.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {screenshot.objects.map((object, index) => (
                            <span
                              key={`${object.kind}-${object.label}-${index}`}
                              className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]"
                            >
                              {object.kind}: {object.label}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

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

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-lg font-medium">Flow understanding</h2>
          <div className="mt-4 space-y-3">
            {video.flowSteps.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No flow steps yet.</p>
            ) : (
              video.flowSteps.map((step) => (
                <article
                  key={`${step.step}-${step.title}`}
                  className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
                >
                  <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
                    Step {step.step} · {formatTime(step.startSec)}-{formatTime(step.endSec)}
                  </p>
                  <p className="mt-1 font-medium">{step.title}</p>
                  <p className="mt-1 text-sm text-[var(--muted)]">{step.summary}</p>
                  <p className="mt-2 text-xs text-[var(--muted)]">
                    User goal: {step.userGoal}
                  </p>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-lg font-medium">Entity relationships</h2>
          <div className="mt-4 space-y-3">
            {video.relationships.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">
                Relationships appear here after memory synthesis.
              </p>
            ) : (
              video.relationships.map((relationship) => (
                <article
                  key={`${relationship.fromEntity}-${relationship.toEntity}-${relationship.relationshipType}`}
                  className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3"
                >
                  <p className="font-medium">
                    {relationship.fromEntity} {relationship.relationshipType}{" "}
                    {relationship.toEntity}
                  </p>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    {relationship.description}
                  </p>
                </article>
              ))
            )}
          </div>
        </section>
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
