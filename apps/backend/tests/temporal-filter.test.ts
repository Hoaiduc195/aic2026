import { describe, expect, it } from 'vitest';

import type { FusedCandidate } from '../src/common/types';
import { filterNearbyCandidates } from '../src/retrieval/temporal-filter';

function candidate(
  videoId: string,
  frameId: number,
  timestampMs: number,
  score: number,
): FusedCandidate {
  return {
    video_id: videoId,
    original_frame_id: frameId,
    timestamp_ms: timestampMs,
    start_ms: timestampMs,
    end_ms: timestampMs + 100,
    score,
    evidence_ids: [`e-${videoId}-${frameId}`],
    matched_modalities: ['caption'],
    fusion_trace: [],
  };
}

describe('filterNearbyCandidates', () => {
  it('keeps the highest-ranked frame in each same-video time window', () => {
    const frames = [
      candidate('video-1', 10, 1000, 0.9),
      candidate('video-1', 11, 1500, 0.8),
      candidate('video-1', 12, 2201, 0.7),
    ];

    expect(filterNearbyCandidates(frames, 1000).map((frame) => frame.original_frame_id)).toEqual([10, 12]);
  });

  it('does not suppress frames from another video', () => {
    const frames = [
      candidate('video-1', 10, 1000, 0.9),
      candidate('video-2', 10, 1000, 0.8),
    ];

    expect(filterNearbyCandidates(frames, 1000)).toHaveLength(2);
  });

  it('returns a copy unchanged when the filter is disabled', () => {
    const frames = [candidate('video-1', 10, 1000, 0.9)];
    const result = filterNearbyCandidates(frames, 0);

    expect(result).toEqual(frames);
    expect(result).not.toBe(frames);
  });
});
