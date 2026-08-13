import type { BranchResult, FusedCandidate, RetrievalExecutionPlan } from '../common/types';

const RRF_K = 60;

function modalityForBranch(branch: string): string {
  if (branch === 'clip') return 'embedding';
  if (branch === 'visual') return 'visual';
  return branch.startsWith('ocr_') ? 'ocr' : branch.startsWith('asr_') ? 'asr' : branch;
}

function candidateKey(videoId: string, segmentId: string, frameId?: number | null): string {
  return `${videoId}:${frameId ?? segmentId}`;
}

export function fuseBranchResults(
  branchResults: readonly BranchResult[],
  plan: RetrievalExecutionPlan,
): FusedCandidate[] {
  const fused = new Map<string, {
    segment_id: string;
    video_id: string;
    original_frame_id?: number | null;
    start_ms: number;
    end_ms: number;
    preview_uri?: string;
    score: number;
    evidence_ids: Set<string>;
    matched_modalities: Set<string>;
  }>();

  for (const branchResult of branchResults) {
    if (branchResult.status !== 'completed') continue;
    for (const candidate of branchResult.candidates.slice(0, plan.top_k_per_branch)) {
      const key = candidateKey(candidate.video_id, candidate.segment_id, candidate.original_frame_id);
      const current = fused.get(key) ?? {
        segment_id: candidate.segment_id,
        video_id: candidate.video_id,
        original_frame_id: candidate.original_frame_id,
        start_ms: candidate.start_ms ?? 0,
        end_ms: Math.max(candidate.end_ms ?? 1, (candidate.start_ms ?? 0) + 1),
        preview_uri: candidate.preview_uri,
        score: 0,
        evidence_ids: new Set<string>(),
        matched_modalities: new Set<string>(),
      };
      current.score += 1 / (RRF_K + Math.max(candidate.rank, 1));
      candidate.evidence_ids.forEach((id) => current.evidence_ids.add(id));
      current.matched_modalities.add(modalityForBranch(branchResult.branch));
      fused.set(key, current);
    }
  }

  return [...fused.values()]
    .sort((left, right) => right.score - left.score || `${left.video_id}:${left.segment_id}`.localeCompare(`${right.video_id}:${right.segment_id}`))
    .slice(0, plan.fusion_k)
    .map((candidate) => ({
      ...candidate,
      evidence_ids: [...candidate.evidence_ids],
      matched_modalities: [...candidate.matched_modalities],
    }));
}
