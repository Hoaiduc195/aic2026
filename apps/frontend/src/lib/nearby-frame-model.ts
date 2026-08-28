export const MIN_NEARBY_FRAME_COUNT = 1;
export const MAX_NEARBY_FRAME_COUNT = 100;
export const DEFAULT_NEARBY_FRAME_COUNT = 4;
export const MIN_NEARBY_FRAME_STEP = 1;
export const MAX_NEARBY_FRAME_STEP = 100_000;
export const DEFAULT_NEARBY_FRAME_STEP = 1;

export function parseNearbyFrameCount(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) return null;
  if (parsed < MIN_NEARBY_FRAME_COUNT || parsed > MAX_NEARBY_FRAME_COUNT) return null;
  return parsed;
}

export function parseNearbyFrameStep(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) return null;
  if (parsed < MIN_NEARBY_FRAME_STEP || parsed > MAX_NEARBY_FRAME_STEP) return null;
  return parsed;
}
