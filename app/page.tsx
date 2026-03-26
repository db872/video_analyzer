import { VideoDashboard } from "@/components/video-dashboard";
import { databaseConfigured } from "@/lib/server/db";
import { listVideos } from "@/lib/server/video-service";

export const dynamic = "force-dynamic";

const blobUploadAvailable =
  process.env.NEXT_PUBLIC_USE_BLOB_UPLOAD === "1";

export default async function Home() {
  const databaseReady = databaseConfigured();
  const videos = databaseReady ? await listVideos() : [];

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <VideoDashboard
        initialVideos={videos}
        databaseReady={databaseReady}
        blobUploadAvailable={blobUploadAvailable}
      />
    </main>
  );
}
