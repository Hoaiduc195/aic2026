import { describe, expect, it } from 'vitest';

import { buildTemporalFrames } from '../src/agent/agent-verification.service';

describe('retrieval-guided temporal windows', () => {
  it('merges nearby anchors, caps windows and samples instead of scanning every raw frame', () => {
    const frames = buildTemporalFrames([
      { timestamp_ms: 30_000, score: 0.9 },
      { timestamp_ms: 35_000, score: 0.8 },
      { timestamp_ms: 90_000, score: 0.7 },
      { timestamp_ms: 150_000, score: 0.1 },
    ], { fps: 25, frame_count: 5_000, duration_ms: 200_000 }, {
      windowSeconds: 20, mergeGapSeconds: 15, windowsPerVideo: 2, sampleFps: 1,
    });

    expect(new Set(frames.map((frame) => frame.window_id)).size).toBe(2);
    expect(frames.length).toBeLessThan(120);
    expect(frames.every((frame, index) => index === 0
      || frame.original_frame_id > frames[index - 1].original_frame_id)).toBe(true);
    expect(frames.some((frame) => Math.abs(frame.timestamp_ms - 30_000) <= 1_000)).toBe(true);
    expect(frames.some((frame) => Math.abs(frame.timestamp_ms - 90_000) <= 1_000)).toBe(true);
  });

  it('clamps a window at the beginning and end of a video', () => {
    const frames = buildTemporalFrames([
      { timestamp_ms: 100, score: 1 }, { timestamp_ms: 9_900, score: 0.9 },
    ], { fps: 10, frame_count: 100, duration_ms: 10_000 }, {
      windowSeconds: 5, mergeGapSeconds: 0, windowsPerVideo: 2, sampleFps: 1,
    });
    expect(frames[0].original_frame_id).toBe(0);
    expect(frames.at(-1)!.original_frame_id).toBeLessThan(100);
  });
});
