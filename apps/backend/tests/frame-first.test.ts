import { describe, expect, it } from 'vitest';

import type { RetrievalExecutionPlan } from '../src/common/types';
import { aggregateBranchCandidates, fuseBranchResults } from '../src/retrieval/fusion';

describe('frame-first retrieval identity', () => {
  it('groups repeated evidence by video and original frame', () => {
    const aggregated = aggregateBranchCandidates([
      { video_id: 'v1', rank: 1, raw_score: 0.9, original_frame_id: 10, start_ms: 100, end_ms: 200, evidence_ids: ['e1'] },
      { video_id: 'v1', rank: 2, raw_score: 0.7, original_frame_id: 10, start_ms: 100, end_ms: 200, evidence_ids: ['e2'] },
      { video_id: 'v1', rank: 3, raw_score: 0.5, original_frame_id: 11, start_ms: 201, end_ms: 300, evidence_ids: ['e3'] },
    ], 10);

    expect(aggregated).toHaveLength(2);
    expect(aggregated[0]).toMatchObject({ video_id: 'v1', original_frame_id: 10, occurrence_count: 2 });
    expect(aggregated[0].evidence_ids).toEqual(['e1', 'e2']);
  });

  it('collapses two retrieval aliases into one canonical result', () => {
    const fused = fuseBranchResults([
      {
        query_id: 'q1',
        branch: 'caption',
        status: 'completed',
        query_variant: 'same source frame',
        candidates: [
          { video_id: 'v1', rank: 1, raw_score: 0.9, original_frame_id: 30578, start_ms: 1020290, end_ms: 1021290, evidence_ids: ['alias-286'] },
          { video_id: 'v1', rank: 2, raw_score: 0.8, original_frame_id: 30578, start_ms: 1020320, end_ms: 1021320, evidence_ids: ['alias-287'] },
        ],
        elapsed_ms: 1,
        deadline_ms: 100,
        index_version: 'idx1',
        producer: 'test',
      },
    ], {
      top_k_per_branch: 10,
      fusion_k: 10,
      channel_weights: { caption: 1 },
    } as RetrievalExecutionPlan);

    expect(fused).toHaveLength(1);
    expect(fused[0]).toMatchObject({ video_id: 'v1', original_frame_id: 30578 });
    expect(fused[0].fusion_trace[0]).toMatchObject({ occurrence_count: 2 });
    expect(fused[0].evidence_ids).toEqual(['alias-286', 'alias-287']);
  });
});
