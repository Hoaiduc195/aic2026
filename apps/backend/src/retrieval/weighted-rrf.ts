import { immutable, immutableArray } from '../common/immutable';
import { BranchName, BranchResult, FusedCandidate } from './retrieval.types';

interface Accumulator {
  candidate: FusedCandidate; branches: Set<BranchName>; evidence: Set<string>; score: number;
}

export function weightedRrf(results: readonly BranchResult[], weights: Partial<Record<BranchName, number>> = {}, k = 60): readonly FusedCandidate[] {
  const bySegment = new Map<string, Accumulator>();
  for (const result of results) {
    if (result.status !== 'completed') continue;
    for (const candidate of result.candidates) {
      const current = bySegment.get(candidate.segmentId) ?? {
        candidate: immutable({ ...candidate, score: 0, matchedBranches: [], evidenceIds: [] }),
        branches: new Set<BranchName>(), evidence: new Set<string>(), score: 0,
      };
      current.score += (weights[result.branch] ?? 1) / (k + candidate.rank);
      current.branches.add(result.branch);
      candidate.evidenceIds.forEach((id) => current.evidence.add(id));
      bySegment.set(candidate.segmentId, current);
    }
  }
  return immutableArray([...bySegment.values()].map((entry) => immutable({
    segmentId: entry.candidate.segmentId, videoId: entry.candidate.videoId,
    startMs: entry.candidate.startMs, endMs: entry.candidate.endMs, score: entry.score,
    matchedBranches: immutableArray([...entry.branches].sort()), evidenceIds: immutableArray([...entry.evidence].sort()),
  })).sort((left, right) => right.score - left.score || left.segmentId.localeCompare(right.segmentId)));
}
