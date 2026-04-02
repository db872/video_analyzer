import { randomUUID } from "crypto";
import { del, put } from "@vercel/blob";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { extname, dirname, join, normalize } from "path";
import { tmpdir } from "os";
import type { StoredArtifact, StorageBackend } from "@/lib/types";

const LOCAL_STORAGE_ROOT = join(process.cwd(), ".data", "storage");

function safeSegment(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "file";
}

function buildLocalPublicUrl(key: string) {
  return `/api/local-storage/${key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function blobEnabled() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export function storageBackendForWrites(): StorageBackend {
  return blobEnabled() ? "blob" : "local";
}

function resolveLocalPath(storageKey: string) {
  const normalizedKey = normalize(storageKey).replace(/^(\.\.(\/|\\|$))+/, "");
  return join(LOCAL_STORAGE_ROOT, normalizedKey);
}

export async function storeBuffer(params: {
  buffer: Buffer;
  prefix: string;
  filename: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
}) {
  const cleanedPrefix = params.prefix
    .split("/")
    .map((segment) => safeSegment(segment))
    .join("/");
  const ext = extname(params.filename) || "";
  const base = safeSegment(params.filename.replace(ext, ""));
  const storageKey = `${cleanedPrefix}/${randomUUID()}-${base}${ext}`;

  if (blobEnabled()) {
    const result = await put(storageKey, params.buffer, {
      access: "public",
      contentType: params.mimeType,
      addRandomSuffix: false,
    });

    return {
      kind: null,
      storageBackend: "blob" as const,
      storageKey,
      publicUrl: result.url,
      mimeType: params.mimeType,
      sizeBytes: params.buffer.byteLength,
      metadata: params.metadata ?? {},
    };
  }

  const outputPath = resolveLocalPath(storageKey);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, params.buffer);

  return {
    kind: null,
    storageBackend: "local" as const,
    storageKey,
    publicUrl: buildLocalPublicUrl(storageKey),
    mimeType: params.mimeType,
    sizeBytes: params.buffer.byteLength,
    metadata: params.metadata ?? {},
  };
}

export async function storeWebFile(params: {
  file: File;
  prefix: string;
  filename?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}) {
  const filename = params.filename ?? params.file.name;
  const mimeType = params.mimeType || params.file.type || "application/octet-stream";
  const buffer = Buffer.from(await params.file.arrayBuffer());

  return storeBuffer({
    buffer,
    prefix: params.prefix,
    filename,
    mimeType,
    metadata: {
      originalFilename: params.file.name,
      ...params.metadata,
    },
  });
}

export async function readStoredArtifact(artifact: Pick<
  StoredArtifact,
  "storageBackend" | "storageKey" | "publicUrl"
>) {
  if (artifact.storageBackend === "external") {
    throw new Error("External source artifacts cannot be materialized as local files.");
  }

  if (artifact.storageBackend === "local") {
    return readFile(resolveLocalPath(artifact.storageKey));
  }

  const response = await fetch(artifact.publicUrl);
  if (!response.ok) {
    throw new Error(`Could not fetch artifact: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function deleteStoredArtifact(artifact: Pick<
  StoredArtifact,
  "storageBackend" | "storageKey" | "publicUrl"
>) {
  if (artifact.storageBackend === "external") {
    return;
  }

  if (artifact.storageBackend === "blob") {
    await del(artifact.publicUrl);
    return;
  }

  await unlink(resolveLocalPath(artifact.storageKey)).catch(() => {});
}

export function getLocalArtifactPath(storageKey: string) {
  return resolveLocalPath(storageKey);
}

export async function materializeArtifactToTempFile(params: {
  artifact: Pick<StoredArtifact, "storageBackend" | "storageKey" | "publicUrl">;
  filename: string;
}) {
  const buffer = await readStoredArtifact(params.artifact);
  const tmpPath = join(tmpdir(), `${randomUUID()}-${safeSegment(params.filename)}`);
  await writeFile(tmpPath, buffer);
  return tmpPath;
}
