import { describe, expect, it } from 'vitest';

import type { FrameCandidate } from '@/lib/contracts';
import {
  applyAnswerToPending,
  completedVqaAnswers,
  fillVqaQueue,
  queueKey,
  toggleVqaQueueDownvote,
  type VqaQueueItem,
} from '@/lib/vqa-queue-model';

function frame(index: number): FrameCandidate {
  return {
    result_key: `video_${index}\u0000${index}`,
    video_id: `video_${index}`,
    original_frame_id: index,
    timestamp_ms: index * 1_000,
    thumbnail_uri: `/frame/${index}`,
    start_ms: index * 1_000,
    end_ms: index * 1_000 + 500,
    score: 1 - index / 100,
    evidence: [],
    matched_modalities: [],
  };
}

describe('VQA queue model', () => {
  it('deduplicates frames by video and original frame identity', () => {
    const first = fillVqaQueue([], [frame(1), frame(2)], new Set(), 100);
    const duplicate = fillVqaQueue(first, [{ ...frame(1), result_key: 'different-result-key' }], new Set(), 100);

    expect(duplicate).toHaveLength(2);
    expect(duplicate.map((item) => item.key)).toEqual([queueKey(frame(1)), queueKey(frame(2))]);
  });

  it('keeps non-downvoted frames before downvoted frames and caps at 100', () => {
    const frames = Array.from({ length: 101 }, (_, index) => frame(index));
    const queue = fillVqaQueue([], frames, new Set([queueKey(frame(0)), queueKey(frame(2))]), 100);

    expect(queue).toHaveLength(100);
    expect(queue.slice(0, 97).every((item) => !item.downvoted)).toBe(true);
    expect(queue.slice(-2).map((item) => item.frame_id)).toEqual([100, 0]);
    expect(queue.some((item) => item.frame_id === 2)).toBe(false);
  });

  it('applies one answer only to pending queue items', () => {
    const queue: VqaQueueItem[] = [
      { ...fillVqaQueue([], [frame(1)], new Set(), 100)[0], status: 'pending' },
      { ...fillVqaQueue([], [frame(2)], new Set(), 100)[0], status: 'answered', answer: 'đã có' },
    ];

    const next = applyAnswerToPending(queue, 'cùng một đáp án');

    expect(next.map((item) => [item.frame_id, item.status, item.answer])).toEqual([
      [1, 'answered', 'cùng một đáp án'],
      [2, 'answered', 'đã có'],
    ]);
  });

  it('moves a downvoted queue item to the end without deleting it', () => {
    const queue = fillVqaQueue([], [frame(1), frame(2)], new Set(), 100);
    const next = toggleVqaQueueDownvote(queue, queue[0].key, true);

    expect(next.map((item) => item.frame_id)).toEqual([2, 1]);
    expect(next[1].downvoted).toBe(true);
  });

  it('converts only answered queue items to submission answers in queue order', () => {
    const queue = fillVqaQueue([], [frame(1), frame(2)], new Set(), 100);
    const answered = applyAnswerToPending(queue, 'answer');

    expect(completedVqaAnswers(answered)).toEqual([
      { video_id: 'video_1', frame_id: 1, answer: 'answer' },
      { video_id: 'video_2', frame_id: 2, answer: 'answer' },
    ]);
  });
});
