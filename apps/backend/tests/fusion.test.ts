import { describe, expect, it } from 'vitest';

import type { BranchResult, RetrievalExecutionPlan } from '../src/common/types';
import { aggregateBranchCandidates, fuseBranchResults } from '../src/retrieval/fusion';

const plan = {
  top_k_per_branch: 100,
  fusion_k: 100,
  channel_weights: { caption: 1, object: 2 },
} as RetrievalExecutionPlan;

function result(branch: BranchResult['branch'], candidates: BranchResult['candidates']): BranchResult {
  return {
    query_id: 'q', branch, status: 'completed', query_variant: 'query', candidates,
    elapsed_ms: 1, deadline_ms: 100, index_version: 'idx', producer: 'test',
  };
}

describe('segment aggregation and weighted RRF', () => {
  it('aggregates repeated frame hits into one canonical segment with a capped occurrence signal', () => {
    const aggregated = aggregateBranchCandidates([
      { segment_id: 's1', video_id: 'v1', rank: 1, raw_score: 0.9, original_frame_id: 10, start_ms: 100, end_ms: 200, evidence_ids: ['e1'] },
      { segment_id: 's1', video_id: 'v1', rank: 2, raw_score: 0.7, original_frame_id: 11, start_ms: 100, end_ms: 200, evidence_ids: ['e2'] },
      { segment_id: 's2', video_id: 'v1', rank: 3, raw_score: 0.5, start_ms: 201, end_ms: 300, evidence_ids: ['e3'] },
    ], 10);
    expect(aggregated).toHaveLength(2);
    expect(aggregated[0]).toMatchObject({ segment_id: 's1', rank: 1, occurrence_count: 2 });
    expect(aggregated[0].evidence_ids).toEqual(['e1', 'e2']);
  });

  it('uses QueryPlan weights and returns an auditable fusion trace', () => {
    const fused = fuseBranchResults([
      result('caption', [{ segment_id: 's1', video_id: 'v1', rank: 1, raw_score: 0.8, start_ms: 0, end_ms: 10, evidence_ids: ['caption-1'] }]),
      result('object', [{ segment_id: 's1', video_id: 'v1', rank: 1, raw_score: 0.9, start_ms: 0, end_ms: 10, evidence_ids: ['object-1'], matched_terms: ['bottle'] }]),
    ], plan);
    expect(fused).toHaveLength(1);
    expect(fused[0].fusion_trace).toHaveLength(2);
    const objectTrace = fused[0].fusion_trace.find((trace) => trace.branch === 'object');
    const captionTrace = fused[0].fusion_trace.find((trace) => trace.branch === 'caption');
    expect(objectTrace?.channel_weight).toBe(2);
    expect(objectTrace!.rrf_contribution).toBeCloseTo(2 * captionTrace!.rrf_contribution);
    expect(objectTrace?.matched_terms).toEqual(['bottle']);
  });
});

