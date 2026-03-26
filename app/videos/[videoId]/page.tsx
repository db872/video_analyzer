import { VideoDetailView } from "@/components/video-detail";
import { databaseConfigured } from "@/lib/server/db";
import { getVideoDetail } from "@/lib/server/video-service";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function VideoPage({
  params,
}: {
  params: Promise<{ videoId: string }>;
}) {
  if (!databaseConfigured()) {
    notFound();
  }

  const { videoId } = await params;
  const video = await getVideoDetail(videoId);

  if (!video) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <VideoDetailView initialVideo={video} />
    </main>
  );
}
