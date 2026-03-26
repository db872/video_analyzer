export function normalizeConfidence(value: unknown) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numeric)) {
    return 0.5;
  }

  if (numeric <= 1) {
    return Math.max(0, numeric);
  }

  if (numeric <= 100) {
    return numeric / 100;
  }

  return 1;
}
