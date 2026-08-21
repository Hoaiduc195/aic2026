import { describe, expect, it } from 'vitest';

import type { FrameCandidate } from '@/lib/contracts';
import {
  completeTrakeQueueItem,
  fillTrakeQueue,
  isCompleteTrakeQueueItem,
  trakeQueueAnswers,
  type TrakeQueueItem,
} from '@/lib/trake-queue-model';

function frame(videoId: string, originalFrameId: number, timestampMs = originalFrameId * 40): FrameCandidate {
  return {
    result_key: `${videoId}\u0000${originalFrameId}`,
    video_id: videoId,
    original_frame_id: originalFrameId,
    timestamp_ms: timestampMs,
    thumbnail_uri: `/frame/${videoId}/${originalFrameId}`,
    start_ms: timestampMs,
    end_ms: timestampMs + 100,
    score: 0.9,
    evidence: [],
    matched_modalities: [],
  };
}

describe('TRAKE queue model', () => {
  it('fills retrieval anchors without requiring four frames', () => {
    const existing: TrakeQueueItem[] = [{ key: 'video-1\u000010', anchor: frame('video-1', 10), frames: [] }];
    const result = fillTrakeQueue(existing, [frame('video-1', 10), frame('video-1', 20), frame('video-2', 30)], 100);

    expect(result.map((item) => item.key)).toEqual(['video-1\u000010', 'video-1\u000020', 'video-2\u000030']);
    expect(result[0].frames).toEqual([]);
    expect(isCompleteTrakeQueueItem(result[0])).toBe(false);
  });

  it('completes an item immutably and exposes only complete answers', () => {
    const item: TrakeQueueItem = { key: 'video-1\u000010', anchor: frame('video-1', 10), frames: [] };
    const selected = [frame('video-1', 10), frame('video-1', 20), frame('video-1', 30), frame('video-1', 40)];
    const completed = completeTrakeQueueItem(item, selected);

    expect(completed).not.toBe(item);
    expect(item.frames).toEqual([]);
    expect(isCompleteTrakeQueueItem(completed)).toBe(true);
    expect(trakeQueueAnswers([item, completed])).toEqual([
      { video_id: 'video-1', frame_ids: [10, 20, 30, 40] },
    ]);
  });

  it('does not complete a sequence containing a fabricated, unordered, or cross-video frame', () => {
    const item: TrakeQueueItem = { key: 'video-1\u000010', anchor: frame('video-1', 10), frames: [] };

    expect(isCompleteTrakeQueueItem(completeTrakeQueueItem(item, [
      frame('video-1', 10), frame('video-1', 20), frame('video-1', 20), frame('video-1', 40),
    ]))).toBe(false);
    expect(isCompleteTrakeQueueItem(completeTrakeQueueItem(item, [
      frame('video-1', 10), frame('video-2', 20), frame('video-1', 30), frame('video-1', 40),
    ]))).toBe(false);
  });
});
