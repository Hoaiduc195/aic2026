import { describe, expect, it } from 'vitest';

import type { VideoFrame } from '@/lib/contracts';
import { buildNearbyFrameCsv } from '@/lib/nearby-frame-export';
import {
  MAX_NEARBY_FRAME_COUNT,
  MAX_NEARBY_FRAME_STEP,
  parseNearbyFrameCount,
  parseNearbyFrameStep,
} from '@/lib/nearby-frame-model';

const center = {
  video_id: 'video_01',
  original_frame_id: 385,
  timestamp_ms: 12_800,
};

function frame(
  originalFrameId: number,
  timestampMs: number,
  overrides: Partial<VideoFrame> = {},
): VideoFrame {
  return {
    video_id: 'video_01',
    keyframe_no: null,
    original_frame_id: originalFrameId,
    timestamp_ms: timestampMs,
    thumbnail_uri: `/frames/${originalFrameId}.jpg`,
    ...overrides,
  };
}

describe('nearby frame context', () => {
  it('accepts an explicit total window size between one and one hundred frames', () => {
    expect(parseNearbyFrameCount('1')).toBe(1);
    expect(parseNearbyFrameCount(String(MAX_NEARBY_FRAME_COUNT))).toBe(MAX_NEARBY_FRAME_COUNT);
    expect(parseNearbyFrameCount('0')).toBeNull();
    expect(parseNearbyFrameCount('101')).toBeNull();
    expect(parseNearbyFrameCount('2.5')).toBeNull();
  });

  it('validates the source-frame spacing independently from Top-K', () => {
    expect(parseNearbyFrameStep('1')).toBe(1);
    expect(parseNearbyFrameStep(String(MAX_NEARBY_FRAME_STEP))).toBe(MAX_NEARBY_FRAME_STEP);
    expect(parseNearbyFrameStep('0')).toBeNull();
    expect(parseNearbyFrameStep(String(MAX_NEARBY_FRAME_STEP + 1))).toBeNull();
    expect(parseNearbyFrameStep('2.5')).toBeNull();
  });

  it('exports the selected center first, removes duplicates, and ignores other videos', () => {
    const csv = buildNearbyFrameCsv(center, [
      frame(350, 11_600, { keyframe_no: 4 }),
      frame(385, 12_800, { keyframe_no: 5 }),
      frame(385, 12_800, { keyframe_no: 5 }),
      frame(411, 13_700, { keyframe_no: 6 }),
      frame(999, 30_000, { video_id: 'video_02' }),
    ]);

    expect(csv).toBe(
      'video_id,original_frame_id,keyframe_no,timestamp_ms,is_center\r\n'
      + 'video_01,385,5,12800,true\r\n'
      + 'video_01,350,4,11600,false\r\n'
      + 'video_01,411,6,13700,false\r\n',
    );
  });

  it('keeps spreadsheet formulas inert when exporting free-form identifiers', () => {
    const csv = buildNearbyFrameCsv({
      ...center,
      video_id: '=HYPERLINK("bad")',
    }, [frame(411, 13_700)]);

    expect(csv).toContain(`"'=HYPERLINK(""bad"")",385`);
  });
});
