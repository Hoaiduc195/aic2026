import type { FrameRef } from './types.js';

export const TOP_VIDEO_FRAME_COUNT = 20;
export const DEFAULT_FOCUS_FRAME_COUNT = TOP_VIDEO_FRAME_COUNT;
export const TOTAL_CSV_ROW_COUNT = 100;

export interface TopVideoCandidate {
  readonly videoId: string;
  readonly originalFrameId: number;
  readonly score?: number;
  readonly sourceRank?: number;
  readonly timestampMs?: number;
}

export interface RankedCsvSelection {
  readonly focusVideoId: string;
  readonly focusFrames: readonly FrameRef[];
  readonly rows: readonly FrameRef[];
  readonly candidateCount: number;
}

/**
 * Selects up to 100 ranked rows and moves a temporal segment from the strongest
 * video to the front. The segment is the tightest candidate window containing
 * the strongest frame, so the focus rows remain temporally concentrated.
 */
export function selectRankedCsvFrames(
  candidates: readonly TopVideoCandidate[],
  focusCount = DEFAULT_FOCUS_FRAME_COUNT,
): RankedCsvSelection | null {
  const normalizedFocusCount = normalizeFocusCount(focusCount);
  const unique = new Map<string, NormalizedCandidate>();

  candidates.forEach((candidate, inputIndex) => {
    if (!isValidCandidate(candidate)) return;
    const normalized = {
      ...candidate,
      sourceRank: candidate.sourceRank ?? inputIndex + 1,
      inputIndex,
    };
    const key = `${candidate.videoId}\u0000${candidate.originalFrameId}`;
    const current = unique.get(key);
    if (!current || compareCandidates(normalized, current) < 0) {
      unique.set(key, {
        ...normalized,
        ...(normalized.timestampMs === undefined && current?.timestampMs !== undefined
          ? { timestampMs: current.timestampMs }
          : {}),
      });
    } else if (current.timestampMs === undefined && normalized.timestampMs !== undefined) {
      unique.set(key, { ...current, timestampMs: normalized.timestampMs });
    }
  });

  const ranked = [...unique.values()].sort(compareCandidates);
  const strongest = ranked[0];
  if (!strongest) return null;

  const sameVideo = ranked
    .filter((candidate) => candidate.videoId === strongest.videoId)
    .sort(compareTemporalCandidates);
  const focusWindow = chooseFocusWindow(sameVideo, strongest, normalizedFocusCount);
  const focusKeys = new Set(focusWindow.map((candidate) => candidateKey(candidate)));
  const focusFrames = ranked
    .filter((candidate) => focusKeys.has(candidateKey(candidate)))
    .slice(0, normalizedFocusCount)
    .map(toFrameRef);
  const remainingFrames = ranked
    .filter((candidate) => !focusKeys.has(candidateKey(candidate)))
    .slice(0, Math.max(0, TOTAL_CSV_ROW_COUNT - focusFrames.length))
    .map(toFrameRef);

  return {
    focusVideoId: strongest.videoId,
    focusFrames,
    rows: [...focusFrames, ...remainingFrames],
    candidateCount: ranked.length,
  };
}

interface NormalizedCandidate extends TopVideoCandidate {
  readonly sourceRank: number;
  readonly inputIndex: number;
}

function isValidCandidate(candidate: TopVideoCandidate): boolean {
  return candidate.videoId.trim().length > 0
    && Number.isSafeInteger(candidate.originalFrameId)
    && candidate.originalFrameId >= 0
    && (candidate.timestampMs === undefined || Number.isFinite(candidate.timestampMs));
}

function compareCandidates(left: NormalizedCandidate, right: NormalizedCandidate): number {
  const leftScore = finiteScore(left.score);
  const rightScore = finiteScore(right.score);
  if (leftScore !== rightScore) {
    if (leftScore === Number.NEGATIVE_INFINITY) return 1;
    if (rightScore === Number.NEGATIVE_INFINITY) return -1;
    return rightScore - leftScore;
  }

  const rankDifference = left.sourceRank - right.sourceRank;
  if (rankDifference !== 0) return rankDifference;
  return left.inputIndex - right.inputIndex;
}

function finiteScore(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function normalizeFocusCount(value: number): number {
  return Number.isSafeInteger(value)
    ? Math.min(TOTAL_CSV_ROW_COUNT, Math.max(1, value))
    : DEFAULT_FOCUS_FRAME_COUNT;
}

function candidateKey(candidate: TopVideoCandidate): string {
  return `${candidate.videoId}\u0000${candidate.originalFrameId}`;
}

function toFrameRef(candidate: TopVideoCandidate): FrameRef {
  return { videoId: candidate.videoId, originalFrameId: candidate.originalFrameId };
}

function compareTemporalCandidates(left: NormalizedCandidate, right: NormalizedCandidate): number {
  const leftTime = temporalValue(left);
  const rightTime = temporalValue(right);
  return leftTime - rightTime || compareCandidates(left, right);
}

function temporalValue(candidate: TopVideoCandidate): number {
  return candidate.timestampMs ?? candidate.originalFrameId;
}

function chooseFocusWindow(
  candidates: readonly NormalizedCandidate[],
  anchor: NormalizedCandidate,
  focusCount: number,
): readonly NormalizedCandidate[] {
  if (candidates.length <= focusCount) return candidates;
  const anchorIndex = candidates.findIndex((candidate) => candidateKey(candidate) === candidateKey(anchor));
  const windows = Array.from({ length: candidates.length - focusCount + 1 }, (_, index) => candidates.slice(index, index + focusCount))
    .filter((window) => window.some((candidate) => candidateKey(candidate) === candidateKey(anchor)));
  const best = [...windows].sort((left, right) => compareWindows(left, right, anchor))[0];
  return best ?? candidates.slice(Math.max(0, anchorIndex), anchorIndex + focusCount);
}

function compareWindows(
  left: readonly NormalizedCandidate[],
  right: readonly NormalizedCandidate[],
  anchor: NormalizedCandidate,
): number {
  const leftSpan = temporalValue(left[left.length - 1]) - temporalValue(left[0]);
  const rightSpan = temporalValue(right[right.length - 1]) - temporalValue(right[0]);
  if (leftSpan !== rightSpan) return leftSpan - rightSpan;

  const leftScore = left.reduce((sum, candidate) => sum + scoreOrZero(candidate.score), 0);
  const rightScore = right.reduce((sum, candidate) => sum + scoreOrZero(candidate.score), 0);
  if (leftScore !== rightScore) return rightScore - leftScore;

  const anchorKey = candidateKey(anchor);
  const leftAnchorDistance = Math.abs(left.findIndex((candidate) => candidateKey(candidate) === anchorKey));
  const rightAnchorDistance = Math.abs(right.findIndex((candidate) => candidateKey(candidate) === anchorKey));
  return leftAnchorDistance - rightAnchorDistance;
}

function scoreOrZero(value: number | undefined): number {
  return finiteScore(value) === Number.NEGATIVE_INFINITY ? 0 : finiteScore(value);
}
