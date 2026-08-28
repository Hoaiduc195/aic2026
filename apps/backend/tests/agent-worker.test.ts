import { describe, expect, it, vi } from 'vitest';

import { frameSignature, judgeBatch, signatureDifference, storyboardLayout, type BatchFrame } from '../src/agent/rest-worker';

describe('REST agent worker cascade', () => {
  it('uses a compact storyboard layout', () => {
    expect(storyboardLayout(16, 4)).toEqual({ columns: 4, rows: 4 });
    expect(storyboardLayout(7, 3)).toEqual({ columns: 3, rows: 3 });
    expect(storyboardLayout(2, 4)).toEqual({ columns: 2, rows: 1 });
  });
  it('checks every decoded frame with a deterministic lightweight visual signature', () => {
    const black = Buffer.alloc(16 * 16 * 3, 0);
    const white = Buffer.alloc(16 * 16 * 3, 255);
    const blackSignature = frameSignature(black, 16);
    const repeated = frameSignature(Buffer.from(black), 16);
    const whiteSignature = frameSignature(white, 16);

    expect(blackSignature).toHaveLength(256);
    expect(signatureDifference(blackSignature, repeated)).toBe(0);
    expect(signatureDifference(blackSignature, whiteSignature)).toBe(1);
    expect(signatureDifference(undefined, blackSignature)).toBe(1);
  });

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

  it('resolves a local dense-frame endpoint before sending it to the VLM', async () => {
    const frame: BatchFrame = {
      video_id: 'L26_V076', original_frame_id: 31,
      thumbnail_uri: '/v1/videos/L26_V076/frames/31/thumbnail',
      frame_source: 'raw_video', clip_score: null, prefilter_route: 'vlm_review',
    };
    const vlm = {
      verifyImageRelevance: vi.fn(async () => ({ score: 60, match: true, reason: 'visible' })),
    };
    const resolveImage = vi.fn(async () => 'data:image/jpeg;base64,ZGVuc2U=');

    await judgeBatch([frame], 'target event', vlm as never, 1, resolveImage);

    expect(resolveImage).toHaveBeenCalledWith(frame);
    expect(vlm.verifyImageRelevance).toHaveBeenCalledWith({
      query: 'target event', imageUrl: 'data:image/jpeg;base64,ZGVuc2U=',
    });
  });
});
