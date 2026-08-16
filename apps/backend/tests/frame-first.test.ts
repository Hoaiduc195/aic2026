import { describe, expect, it } from 'vitest';

import { aggregateBranchCandidates } from '../src/retrieval/fusion';

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
});
