import { describe, expect, it } from 'vitest';

import {
  activeAsrSpans,
  frameThumbnailUri,
  keyframeLabel,
  nearestStudioFrame,
  timelinePercent,
} from '@/lib/video-studio-model';
import type { StudioAsrSpan, StudioFrame } from '@/lib/contracts';

const frames: StudioFrame[] = [
  {
    video_id: 'video-1', keyframe_no: 1, original_frame_id: 0, timestamp_ms: 0,
    captions: [], objects: [],
  },
  {
    video_id: 'video-1', keyframe_no: 2, original_frame_id: 50, timestamp_ms: 2_000,
    captions: [], objects: [],
  },
  {
    video_id: 'video-1', keyframe_no: 3, original_frame_id: 100, timestamp_ms: 5_000,
    captions: [], objects: [],
  },
];

const spans: StudioAsrSpan[] = [
  { evidence_id: 'asr-1', start_ms: 1_000, end_ms: 3_000, text: 'Xin chào', language: 'vi', producer: 'asr:v1' },
  { evidence_id: 'asr-2', start_ms: 3_000, end_ms: 6_000, text: 'Tiếp theo', language: 'vi', producer: 'asr:v1' },
];

describe('video studio model', () => {
  it('finds the nearest canonical frame with deterministic tie-breaking', () => {
    expect(nearestStudioFrame(frames, 1_700)?.original_frame_id).toBe(50);
    expect(nearestStudioFrame(frames, 3_500)?.original_frame_id).toBe(50);
    expect(nearestStudioFrame([], 100)).toBeNull();
  });

  it('returns ASR spans containing the selected timestamp with half-open intervals', () => {
    expect(activeAsrSpans(spans, 1_000).map((span) => span.evidence_id)).toEqual(['asr-1']);
    expect(activeAsrSpans(spans, 3_000).map((span) => span.evidence_id)).toEqual(['asr-2']);
    expect(activeAsrSpans(spans, 6_000)).toEqual([]);
  });

  it('maps timeline values to a safe percentage and builds lazy thumbnail URLs', () => {
    expect(timelinePercent(30_000, 60_000)).toBe(50);
    expect(timelinePercent(-1, 60_000)).toBe(0);
    expect(timelinePercent(90_000, 60_000)).toBe(100);
    expect(frameThumbnailUri('video-1', 50)).toBe('/api/v1/media/keyframes/video-1/by-frame/50');
  });

  it('labels the ordinal keyframe separately from its source frame number', () => {
    expect(keyframeLabel(frames[1])).toBe('Keyframe 2 · source frame 50');
  });
});
