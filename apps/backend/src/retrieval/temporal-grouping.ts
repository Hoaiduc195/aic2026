import { immutable, immutableArray } from '../common/immutable';
import { FusedCandidate } from './retrieval.types';

export function groupTemporalCandidates(input: readonly FusedCandidate[], overlapThreshold = 0.5): readonly FusedCandidate[] {
  const sorted = [...input].sort((a, b) => a.videoId.localeCompare(b.videoId) || a.startMs - b.startMs || b.score - a.score);
  const groups: FusedCandidate[] = [];
  for (const candidate of sorted) {
    const index = groups.findIndex((group) => group.videoId === candidate.videoId && overlap(group, candidate) >= overlapThreshold);
    if (index < 0) { groups.push(immutable({ ...candidate })); continue; }
    const current = groups[index];
    const best = current.score >= candidate.score ? current : candidate;
    groups[index] = immutable({
      segmentId: best.segmentId, videoId: best.videoId,
      startMs: best.startMs, endMs: best.endMs,
      score: Math.max(current.score, candidate.score),
      matchedBranches: immutableArray([...new Set([...current.matchedBranches, ...candidate.matchedBranches])].sort()),
      evidenceIds: immutableArray([...new Set([...current.evidenceIds, ...candidate.evidenceIds])].sort()),
    });
  }
  return immutableArray(groups.sort((a, b) => b.score - a.score || a.segmentId.localeCompare(b.segmentId)));
}

function overlap(a: FusedCandidate, b: FusedCandidate): number {
  const intersection = Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
  return intersection / Math.max(1, Math.min(a.endMs - a.startMs, b.endMs - b.startMs));
}
