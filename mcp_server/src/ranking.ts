import type { RankedFrame } from './types.js';

export interface RankFrameCandidate {
  readonly videoId: string;
  readonly originalFrameId: number;
  readonly keyframeNo?: number;
  readonly score: number;
  readonly sourceRank: number;
}

export function rankFrameCandidates(candidates: readonly RankFrameCandidate[]): RankedFrame[] {
  const bestByFrame = new Map<string, RankFrameCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.videoId}\u0000${candidate.originalFrameId}`;
    const current = bestByFrame.get(key);
    if (!current || candidate.score > current.score || (candidate.score === current.score && candidate.sourceRank < current.sourceRank)) {
      bestByFrame.set(key, candidate);
    }
  }
  return [...bestByFrame.values()]
    .sort((left, right) => right.score - left.score
      || left.sourceRank - right.sourceRank
      || left.videoId.localeCompare(right.videoId)
      || left.originalFrameId - right.originalFrameId)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function lexicalEvidenceScore(query: string, values: readonly string[]): number {
  const terms = query.toLocaleLowerCase().split(/\s+/u).map((term) => term.trim()).filter((term) => term.length > 1);
  if (terms.length === 0) return 0;
  const haystack = values.join(' ').toLocaleLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) / terms.length;
}
