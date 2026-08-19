import type { FusedCandidate } from '../common/types';

function candidateTimestamp(candidate: FusedCandidate): number {
  const timestamp = candidate.timestamp_ms;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : candidate.start_ms;
}

function candidateSort(left: FusedCandidate, right: FusedCandidate): number {
  return right.score - left.score
    || left.video_id.localeCompare(right.video_id)
    || (left.original_frame_id ?? Number.MAX_SAFE_INTEGER) - (right.original_frame_id ?? Number.MAX_SAFE_INTEGER)
    || left.start_ms - right.start_ms;
}

/** Keep the best-scoring source frame in each temporal neighborhood per video. */
export function filterNearbyCandidates(
  candidates: readonly FusedCandidate[],
  windowMs: number,
): FusedCandidate[] {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return [...candidates];

  const ranked = [...candidates].sort(candidateSort);
  const keptByVideo = new Map<string, FusedCandidate[]>();
  const kept: FusedCandidate[] = [];

  for (const candidate of ranked) {
    const timestamp = candidateTimestamp(candidate);
    const sameVideo = keptByVideo.get(candidate.video_id) ?? [];
    const isNearby = sameVideo.some((existing) => (
      Math.abs(candidateTimestamp(existing) - timestamp) <= windowMs
    ));
    if (isNearby) continue;
    kept.push(candidate);
    keptByVideo.set(candidate.video_id, [...sameVideo, candidate]);
  }

  return kept;
}
