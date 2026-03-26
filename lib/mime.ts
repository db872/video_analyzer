export function guessVideoMime(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".avi")) return "video/x-msvideo";
  return "video/mp4";
}

export function guessAudioMime(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".aac")) return "audio/aac";
  return "audio/mpeg";
}

export function guessImageMime(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

export function guessMimeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (/\.(mp4|webm|mov|mkv|avi)$/.test(lower)) return guessVideoMime(lower);
  if (/\.(mp3|wav|m4a|aac)$/.test(lower)) return guessAudioMime(lower);
  if (/\.(jpg|jpeg|png|webp)$/.test(lower)) return guessImageMime(lower);
  return "application/octet-stream";
}
