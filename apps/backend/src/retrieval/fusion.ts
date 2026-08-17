import type {
  BranchCandidate, BranchName, BranchResult, FusedCandidate, FusionTraceEntry, RetrievalExecutionPlan,
} from '../common/types';

const DEFAULT_RRF_K = 60;
const TOP_M = 3;
const MAX_OCCURRENCE_BONUS = 0.10;

function modalityForBranch(branch: BranchName): string {
  if (branch === 'clip') return 'embedding';
  if (branch === 'visual') return 'visual';
  return branch.startsWith('ocr_') ? 'ocr' : branch.startsWith('asr_') ? 'asr' : branch;
}

export function candidateKey(
  videoId: string,
  originalFrameId: number | null | undefined,
  startMs?: number,
  endMs?: number,
): string {
  // keyframe_no is intentionally absent: multiple sparse aliases can point
  // to one canonical source frame and must be fused into one result.
  if (originalFrameId !== null && originalFrameId !== undefined) {
    return `${videoId}:frame:${originalFrameId}`;
  }
  return `${videoId}:time:${startMs ?? 0}:${endMs ?? 1}`;
}

export interface AggregatedBranchCandidate extends BranchCandidate {
  readonly occurrence_count: number;
}

/** Convert frame/evidence hits from one channel into one ranked hit per source frame. */
export function aggregateBranchCandidates(
  candidates: readonly BranchCandidate[],
  limit: number,
): AggregatedBranchCandidate[] {
  const grouped = new Map<string, BranchCandidate[]>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate.video_id, candidate.original_frame_id, candidate.start_ms, candidate.end_ms);
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  return [...grouped.values()]
    .map((hits): AggregatedBranchCandidate => {
      const sorted = [...hits].sort((left, right) => right.raw_score - left.raw_score || left.rank - right.rank);
      const representative = sorted[0];
      const top = sorted.slice(0, TOP_M);
      const topMean = top.reduce((sum, hit) => sum + hit.raw_score, 0) / top.length;
      const occurrenceBonus = Math.min(MAX_OCCURRENCE_BONUS, Math.max(0, hits.length - 1) * 0.02);
      const starts = hits.map((hit) => hit.start_ms).filter((value): value is number => Number.isFinite(value));
      const ends = hits.map((hit) => hit.end_ms).filter((value): value is number => Number.isFinite(value));
      const startMs = starts.length > 0 ? Math.min(...starts) : 0;
      return {
        ...representative,
        rank: 0,
        raw_score: 0.7 * representative.raw_score + 0.3 * topMean + occurrenceBonus,
        start_ms: startMs,
        end_ms: Math.max(ends.length > 0 ? Math.max(...ends) : startMs + 1, startMs + 1),
        evidence_ids: [...new Set(hits.flatMap((hit) => hit.evidence_ids))],
        matched_terms: [...new Set(hits.flatMap((hit) => hit.matched_terms ?? []))],
        occurrence_count: hits.length,
      };
    })
    .sort((left, right) => right.raw_score - left.raw_score
      || candidateKey(left.video_id, left.original_frame_id, left.start_ms, left.end_ms)
        .localeCompare(candidateKey(right.video_id, right.original_frame_id, right.start_ms, right.end_ms)))
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function fuseBranchResults(
  branchResults: readonly BranchResult[],
  plan: RetrievalExecutionPlan,
): FusedCandidate[] {
  const fused = new Map<string, {
    video_id: string;
    video_object_key?: string | null;
    keyframe_no?: number | null;
    original_frame_id?: number | null;
    start_ms: number;
    end_ms: number;
    preview_uri?: string;
    score: number;
    evidence_ids: Set<string>;
    matched_modalities: Set<string>;
    fusion_trace: FusionTraceEntry[];
  }>();
  const rrfK = Number.isFinite(plan.rrf_k) ? plan.rrf_k : DEFAULT_RRF_K;

  for (const branchResult of branchResults) {
    if (branchResult.status !== 'completed') continue;
    const weight = plan.channel_weights[branchResult.branch] ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    for (const candidate of aggregateBranchCandidates(branchResult.candidates, plan.top_k_per_branch)) {
      const key = candidateKey(candidate.video_id, candidate.original_frame_id, candidate.start_ms, candidate.end_ms);
      const contribution = weight / (rrfK + candidate.rank);
      const current = fused.get(key) ?? {
        video_id: candidate.video_id,
        video_object_key: candidate.video_object_key,
        keyframe_no: candidate.keyframe_no,
        original_frame_id: candidate.original_frame_id,
        start_ms: candidate.start_ms ?? 0,
        end_ms: Math.max(candidate.end_ms ?? 1, (candidate.start_ms ?? 0) + 1),
        preview_uri: candidate.preview_uri,
        score: 0,
        evidence_ids: new Set<string>(),
        matched_modalities: new Set<string>(),
        fusion_trace: [],
      };
      current.video_object_key ??= candidate.video_object_key;
      current.keyframe_no ??= candidate.keyframe_no;
      current.original_frame_id ??= candidate.original_frame_id;
      current.score += contribution;
      current.start_ms = Math.min(current.start_ms, candidate.start_ms ?? current.start_ms);
      current.end_ms = Math.max(current.end_ms, candidate.end_ms ?? current.end_ms);
      candidate.evidence_ids.forEach((id) => current.evidence_ids.add(id));
      current.matched_modalities.add(modalityForBranch(branchResult.branch));
      current.fusion_trace.push({
        branch: branchResult.branch,
        channel_rank: candidate.rank,
        channel_weight: weight,
        rrf_contribution: contribution,
        aggregated_raw_score: candidate.raw_score,
        occurrence_count: candidate.occurrence_count,
        evidence_ids: candidate.evidence_ids,
        matched_terms: candidate.matched_terms ?? [],
      });
      fused.set(key, current);
    }
  }

  return [...fused.values()]
    .sort((left, right) => right.score - left.score
      || candidateKey(left.video_id, left.original_frame_id, left.start_ms, left.end_ms)
        .localeCompare(candidateKey(right.video_id, right.original_frame_id, right.start_ms, right.end_ms)))
    .slice(0, plan.fusion_k)
    .map((candidate) => ({
      ...candidate,
      evidence_ids: [...candidate.evidence_ids],
      matched_modalities: [...candidate.matched_modalities],
      fusion_trace: [...candidate.fusion_trace].sort((left, right) => right.rrf_contribution - left.rrf_contribution),
    }));
}
