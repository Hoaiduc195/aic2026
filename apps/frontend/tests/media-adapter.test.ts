import { describe, expect, it } from 'vitest';

import { isSafeVideoId, parseByteRange, parseFrameMapCsv, selectFrameWindow } from '@/lib/media-adapter';

const csv = `n,pts_time,fps,frame_idx
1,0.0,30.0,0
2,3.0,30.0,90
3,8.7,30.0,261
4,11.7333,30.0,351
5,13.7,30.0,411
6,17.7,30.0,531`;

describe('local media adapter', () => {
  it('parses frame maps and selects a centered window around the nearest source frame', () => {
    const frames = parseFrameMapCsv(csv, 'L21_V001');
    const selected = selectFrameWindow(frames, 385, 3);

    expect(selected.map((frame) => frame.original_frame_id)).toEqual([351, 411, 531]);
    expect(selected[1]).toMatchObject({ keyframe_no: 5, timestamp_ms: 13_700 });
  });

  it('validates video IDs and byte ranges without allowing traversal', () => {
    expect(isSafeVideoId('L21_V001')).toBe(true);
    expect(isSafeVideoId('../L21_V001')).toBe(false);
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=100-120', 100)).toBeNull();
  });
});
