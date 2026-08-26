import { describe, expect, it } from 'vitest';

import { rankFrameCandidates } from '../src/ranking.js';

describe('frame ranking', () => {
  it('ranks candidates by backend score and preserves deterministic ties', () => {
    const ranked = rankFrameCandidates([
      { videoId: 'v', originalFrameId: 2, score: 0.4, sourceRank: 2 },
      { videoId: 'v', originalFrameId: 1, score: 0.9, sourceRank: 3 },
      { videoId: 'v', originalFrameId: 3, score: 0.9, sourceRank: 1 },
    ]);

    expect(ranked.map((item) => `${item.videoId}:${item.originalFrameId}`)).toEqual([
      'v:3',
      'v:1',
      'v:2',
    ]);
    expect(ranked.map((item) => item.rank)).toEqual([1, 2, 3]);
  });

  it('deduplicates the same source frame and keeps its strongest score', () => {
    const ranked = rankFrameCandidates([
      { videoId: 'v', originalFrameId: 1, score: 0.2, sourceRank: 9 },
      { videoId: 'v', originalFrameId: 1, score: 0.8, sourceRank: 2 },
    ]);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ originalFrameId: 1, score: 0.8, sourceRank: 2, rank: 1 });
  });
});
