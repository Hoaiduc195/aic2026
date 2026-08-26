import { describe, expect, it, vi } from 'vitest';

import { judgeBatch, type BatchFrame } from '../src/agent/rest-worker';

describe('REST agent worker cascade', () => {
  it('uses CLIP for confident frames and sends only ambiguous frames to the VLM', async () => {
    const frames: BatchFrame[] = [
      {
        video_id: 'L26_V076', original_frame_id: 10, thumbnail_uri: 'https://r2/10.jpg',
        clip_score: 0.02, prefilter_route: 'auto_reject',
      },
      {
        video_id: 'L26_V076', original_frame_id: 20, thumbnail_uri: 'https://r2/20.jpg',
        clip_score: 0.7, prefilter_route: 'auto_accept',
      },
      {
        video_id: 'L26_V076', original_frame_id: 30, thumbnail_uri: 'https://r2/30.jpg',
        clip_score: 0.25, prefilter_route: 'vlm_review',
      },
    ];
    const vlm = {
      verifyImageRelevance: vi.fn(async () => ({ score: 82, match: true, reason: 'matching action' })),
    };

    const judgments = await judgeBatch(frames, 'person carrying a bag', vlm as never, 2);

    expect(vlm.verifyImageRelevance).toHaveBeenCalledTimes(1);
    expect(vlm.verifyImageRelevance).toHaveBeenCalledWith({
      query: 'person carrying a bag', imageUrl: 'https://r2/30.jpg',
    });
    expect(judgments).toEqual([
      expect.objectContaining({ original_frame_id: 10, relevant: false, reason: expect.stringContaining('clip_auto_reject') }),
      expect.objectContaining({ original_frame_id: 20, relevant: true, reason: expect.stringContaining('clip_auto_accept') }),
      expect.objectContaining({ original_frame_id: 30, relevant: true, score: 0.82, reason: 'vlm:matching action' }),
    ]);
  });
});
