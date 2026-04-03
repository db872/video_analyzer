# PM Video Analyzer

PM Video Analyzer is now a small persisted video workspace instead of a one-shot demo.

It stores videos, analysis runs, derived artifacts, and reports so you can:

- CRUD narrated walkthrough videos
- boost audio before transcription
- use transcript as the global context for the whole walkthrough
- inspect targeted video clips for local visual evidence
- generate bug-ticket style reports and UI/domain object-model reports
- still export selected clips client-side as MP4 + TXT

## Architecture docs

See [`docs/architecture.md`](docs/architecture.md) for the full system design, queue model, persistence layout, and pipeline step breakdown.

## Recommended workflow

Use local video files when you want the most reliable experience.

- Local uploads are the primary supported path for transcript analysis, screenshots, notes, and clip export.
- Public YouTube URLs are supported on a best-effort basis, but server-side downloads can fail depending on YouTube restrictions, cookies, and session freshness.
- If you need stable frame extraction or screenshot generation, prefer uploading the video file directly.

## Stack

- `Next.js` App Router
- `Neon Postgres` via `@neondatabase/serverless`
- `Gemini` via `@google/genai`
- `Vercel Blob` when configured, otherwise local file storage
- `ffmpeg-static` for server-side preprocessing
- `ffmpeg.wasm` for client-side clip export

## Setup

1. Copy `.env.example` to `.env.local`.
2. Set `GEMINI_API_KEY`.
3. Set `DATABASE_URL` to a Neon Postgres connection string.
4. Optionally set `BLOB_READ_WRITE_TOKEN` and `NEXT_PUBLIC_USE_BLOB_UPLOAD=1` for direct Blob uploads.
5. Install and run:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

`npm run dev` uses the standard Next.js development server with automatic rebuilding and Fast Refresh on save. If you want to try Turbopack locally, use `npm run dev:turbo`.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Server-only Gemini API key |
| `DATABASE_URL` | Yes | Neon Postgres connection string for persisted videos/runs |
| `GEMINI_MODEL` | No | Defaults to `gemini-3.1-pro-preview` |
| `GEMINI_TRANSCRIPTION_MODEL` | No | Optional dedicated Gemini model for transcription, default `gemini-3-flash-preview` |
| `MAX_UPLOAD_BYTES` | No | Max accepted upload size for multipart and temp processing |
| `TRANSCRIPTION_CHUNK_SEC` | No | Chunk size for long extracted audio transcription, default `120` |
| `CLIP_CONTEXT_PAD_SEC` | No | Extra seconds padded around each transcript-derived clip window, default `8` |
| `MAX_CLIP_ANALYSES` | No | Maximum targeted clips sent for visual analysis, default `6` |
| `MAX_PROMPTED_SNAPSHOTS` | No | Maximum prompted snapshots selected for analyze mode, default `6` |
| `YTDLP_COOKIES_FROM_BROWSER` | No | Optional browser source for `yt-dlp` cookies, e.g. `chrome` or `safari`, when YouTube Analyze downloads need auth |
| `YTDLP_COOKIES_FILE` | No | Optional Netscape/Mozilla cookie file path passed to `yt-dlp --cookies` |
| `YTDLP_USER_AGENT` | No | Optional user agent string passed to `yt-dlp` for cookie-backed requests |
| `YTDLP_EXTRACTOR_ARGS` | No | Optional `yt-dlp --extractor-args` override for YouTube troubleshooting |
| `BLOB_READ_WRITE_TOKEN` | Optional | Enables Blob-backed artifact storage |
| `NEXT_PUBLIC_USE_BLOB_UPLOAD` | Optional | Set to `1` to expose direct Blob uploads in the UI |
| `ANALYSIS_WORKER_CONCURRENCY` | No | Total in-process worker concurrency, default `4` |
| `ANALYSIS_TRANSCRIBE_CONCURRENCY` | No | Max concurrent transcription jobs, default `3` |
| `ANALYSIS_CLIP_CONCURRENCY` | No | Max concurrent clip-analysis jobs, default `2` |
| `ANALYSIS_SNAPSHOT_CONCURRENCY` | No | Max concurrent snapshot-analysis jobs, default `3` |

## What gets stored

For each video, the app persists:

- the source video artifact
- analysis runs and their status/stage
- boosted audio artifact
- transcript segments with timestamps
- flow steps
- moments for frustration, bugs, and feature requests
- inferred entities and relationships
- generated reports in JSON plus HTML
- analysis jobs, dependencies, and staged intermediate outputs for queued runs

## Main routes

- `/`: dashboard for video CRUD and analysis runs
- `/videos/[videoId]`: detail page with playback, transcript, moments, and reports
- `/api/videos`: create/list videos
- `/api/videos/[videoId]/analyze`: run the persisted analysis pipeline
- `/api/videos/[videoId]/reports/[reportType]`: download JSON or HTML reports
- `/api/blob`: Blob direct-upload token endpoint

## Analysis pipeline

Analysis runs are now queue-backed and processed by an in-process worker. The analyze API enqueues work, returns immediately, and the UI polls progress from persisted run/job state.

High-level flow:

1. Enqueue an `analysis_run` plus root `prepare_media` job.
2. Materialize the source video when needed and extract boosted mono WAV audio with ffmpeg.
3. Fan out transcription jobs per audio chunk, then merge transcript output in order.
4. Branch by mode:
5. `pm_report`: infer flow + moments, fan out targeted clip jobs, merge clip findings, build object model, generate reports.
6. `analyze`: select prompted snapshots, fan out snapshot jobs, merge notes/snapshots.
7. Persist final outputs into the read-optimized domain tables used by the UI.

Detailed step-by-step architecture lives in [`docs/architecture.md`](docs/architecture.md).

## Source types

### Local files

- Fully supported.
- Best option for PM report mode and Analyze mode.
- Supports boosted audio extraction, screenshot generation, and clip export.

### YouTube URLs

- Best-effort support only.
- Gemini can analyze public YouTube URLs directly for transcript and video understanding.
- Analyze mode may attempt to download the YouTube source server-side in order to extract real screenshots, but this can fail because of YouTube anti-bot rules, cookie requirements, or session expiry.
- If YouTube download fails, use a local file instead of trying to force the URL path.

## Local-first notes

- If `BLOB_READ_WRITE_TOKEN` is missing, artifacts are stored under local runtime storage and served back through a local route.
- If `DATABASE_URL` is missing, the UI still loads but will prompt for database setup and block video creation.
- The clip exporter still runs in the browser with `ffmpeg.wasm`, so the first export may take a while to load.

## Vercel notes

- Large multipart uploads are still a poor fit for Vercel Route Handlers. Prefer Blob direct upload in production.
- The current preprocessing and analysis flow is queue-backed, but the worker still runs in-process inside the app server.
- Blob URLs should be treated as trusted only when they originate from your own store.
- Server-side YouTube downloading is not a production-stable path at the moment; treat it as experimental.
