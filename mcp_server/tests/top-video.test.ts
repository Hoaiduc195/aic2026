import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FOCUS_FRAME_COUNT,
  TOTAL_CSV_ROW_COUNT,
  selectRankedCsvFrames,
} from '../src/top-video.js';

describe('selectRankedCsvFrames', () => {
  it('keeps the default top 20 inside one temporal segment while returning up to 100 ranked rows', () => {
    const candidates = [
      ...Array.from({ length: DEFAULT_FOCUS_FRAME_COUNT }, (_, index) => ({
        videoId: 'video-best',
        originalFrameId: index + 10,
        score: 0.9 - index / 1000,
        sourceRank: index + 1,
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        videoId: 'video-best',
        originalFrameId: index + 1_000,
        score: 0.7 - index / 1000,
        sourceRank: index + 21,
      })),
      ...Array.from({ length: 60 }, (_, index) => ({
        videoId: 'video-other',
        originalFrameId: index + 1,
        score: 0.8 - index / 1000,
        sourceRank: index + 41,
      })),
    ];

    const selection = selectRankedCsvFrames(candidates);

    expect(selection?.focusVideoId).toBe('video-best');
    expect(selection?.focusFrames).toEqual(Array.from({ length: DEFAULT_FOCUS_FRAME_COUNT }, (_, index) => ({
        videoId: 'video-best',
        originalFrameId: index + 10,
      })));
    expect(selection?.rows).toHaveLength(TOTAL_CSV_ROW_COUNT);
    expect(selection?.rows.slice(0, DEFAULT_FOCUS_FRAME_COUNT).every((frame) => frame.videoId === 'video-best')).toBe(true);
  });

  it('accepts a prompt-provided focus count without changing the 100-row cap', () => {
    const selection = selectRankedCsvFrames(
      Array.from({ length: TOTAL_CSV_ROW_COUNT }, (_, index) => ({
        videoId: 'video-a',
        originalFrameId: index,
        score: 1 - index / 1000,
        sourceRank: index + 1,
      })),
      5,
    );

    expect(selection?.focusFrames).toHaveLength(5);
    expect(selection?.rows).toHaveLength(TOTAL_CSV_ROW_COUNT);
    expect(selection?.rows.slice(0, 5).every((frame) => frame.videoId === 'video-a')).toBe(true);
  });

  it('uses timestamps to choose the tightest segment around the strongest frame', () => {
    const selection = selectRankedCsvFrames([
      { videoId: 'video-a', originalFrameId: 100, timestampMs: 1_000, score: 0.8, sourceRank: 2 },
      { videoId: 'video-a', originalFrameId: 101, timestampMs: 1_100, score: 0.95, sourceRank: 1 },
      { videoId: 'video-a', originalFrameId: 102, timestampMs: 1_200, score: 0.79, sourceRank: 3 },
      { videoId: 'video-a', originalFrameId: 200, timestampMs: 20_000, score: 0.78, sourceRank: 4 },
    ], 3);

    expect(selection?.focusFrames.map((frame) => frame.originalFrameId)).toEqual([101, 100, 102]);
  });

  it('deduplicates canonical frames and uses source rank as the deterministic tie breaker', () => {
    const selection = selectRankedCsvFrames([
      { videoId: 'video-a', originalFrameId: 20, score: 0.8, sourceRank: 2 },
      { videoId: 'video-a', originalFrameId: 10, score: 0.8, sourceRank: 1 },
      { videoId: 'video-a', originalFrameId: 10, score: 0.7, sourceRank: 3 },
    ], 2);

    expect(selection?.focusFrames).toEqual([
        { videoId: 'video-a', originalFrameId: 10 },
        { videoId: 'video-a', originalFrameId: 20 },
    ]);
  });

  it('returns null when no candidate has a valid exact frame identity', () => {
    expect(selectRankedCsvFrames([
      { videoId: '', originalFrameId: -1, score: 1, sourceRank: 1 },
    ])).toBeNull();
  });
});
