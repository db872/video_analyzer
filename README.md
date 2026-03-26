# PM Video Analyzer

PM Video Analyzer is now a small persisted video workspace instead of a one-shot demo.

It stores videos, analysis runs, derived artifacts, screenshot memory, and reports so you can:

- CRUD narrated walkthrough videos
- boost audio before transcription
- sample screenshots every X seconds
- build reusable video memory from transcript plus screen state
- generate bug-ticket style reports and UI/domain object-model reports
- still export selected clips client-side as MP4 + TXT

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

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Server-only Gemini API key |
| `DATABASE_URL` | Yes | Neon Postgres connection string for persisted videos/runs |
| `GEMINI_MODEL` | No | Defaults to `gemini-3.1-pro-preview` |
| `GEMINI_TRANSCRIPTION_MODEL` | No | Optional dedicated Gemini model for transcription, default `gemini-3-flash-preview` |
| `MAX_UPLOAD_BYTES` | No | Max accepted upload size for multipart and temp processing |
| `SCREENSHOT_INTERVAL_SEC` | No | Screenshot sampling cadence, default `8` |
| `MAX_SCREENSHOTS` | No | Maximum screenshots persisted per run, default `16` |
| `TRANSCRIPTION_CHUNK_SEC` | No | Chunk size for long extracted audio transcription, default `120` |
| `BLOB_READ_WRITE_TOKEN` | Optional | Enables Blob-backed artifact storage |
| `NEXT_PUBLIC_USE_BLOB_UPLOAD` | Optional | Set to `1` to expose direct Blob uploads in the UI |

## What gets stored

For each video, the app persists:

- the source video artifact
- analysis runs and their status/stage
- boosted audio artifact
- screenshot artifacts
- transcript segments with timestamps
- flow steps
- moments for frustration, bugs, and feature requests
- inferred entities and relationships
- generated reports in JSON plus HTML

## Main routes

- `/`: dashboard for video CRUD and analysis runs
- `/videos/[videoId]`: detail page with playback, transcript, screenshots, memory, and reports
- `/api/videos`: create/list videos
- `/api/videos/[videoId]/analyze`: run the persisted analysis pipeline
- `/api/videos/[videoId]/reports/[reportType]`: download JSON or HTML reports
- `/api/blob`: Blob direct-upload token endpoint

## Analysis pipeline

Each run does the following:

1. Load the source video artifact from Blob or local storage.
2. Extract boosted mono WAV audio with ffmpeg.
3. Sample screenshots on a fixed cadence.
4. Chunk the boosted audio and transcribe each chunk with Gemini.
5. Understand each screenshot with Gemini.
6. Synthesize flow steps and frustration/bug/feature moments.
7. Build a reusable object/relationship model from transcript plus screenshots.
8. Persist reports for bugs, timeline, and object model.

## Local-first notes

- If `BLOB_READ_WRITE_TOKEN` is missing, artifacts are stored under local runtime storage and served back through a local route.
- If `DATABASE_URL` is missing, the UI still loads but will prompt for database setup and block video creation.
- The clip exporter still runs in the browser with `ffmpeg.wasm`, so the first export may take a while to load.

## Vercel notes

- Large multipart uploads are still a poor fit for Vercel Route Handlers. Prefer Blob direct upload in production.
- The current preprocessing and analysis flow runs inline inside the request. It works locally and is compatible with a future move to background jobs or workflow tooling.
- Blob URLs should be treated as trusted only when they originate from your own store.
