import { describe, expect, it } from 'vitest';

import type { FrameCandidate } from '@/lib/contracts';
import type { VqaBatchResult } from '@/lib/vqa-batch';
import {
  applyAnswerToAll,
  applyAnswerToPending,
  applyVqaBatchResults,
  autoFillVqaQueueWithMajority,
  completedVqaAnswers,
  fillVqaQueue,
  queueKey,
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
    const first = fillVqaQueue([], [frame(1), frame(2)], 100);
    const duplicate = fillVqaQueue(first, [{ ...frame(1), result_key: 'different-result-key' }], 100);

    expect(duplicate).toHaveLength(2);
    expect(duplicate.map((item) => item.key)).toEqual([queueKey(frame(1)), queueKey(frame(2))]);
  });

  it('preserves ranked frame order and caps the queue at 100 items', () => {
    const frames = Array.from({ length: 101 }, (_, index) => frame(index));
    const queue = fillVqaQueue([], frames, 100);

    expect(queue).toHaveLength(100);
    expect(queue.slice(0, 3).map((item) => item.frame_id)).toEqual([0, 1, 2]);
    expect(queue.at(-1)?.frame_id).toBe(99);
  });

  it('applies one answer to every unresolved queue item', () => {
    const queue: VqaQueueItem[] = [
      { ...fillVqaQueue([], [frame(1)], 100)[0], status: 'pending' },
      { ...fillVqaQueue([], [frame(2)], 100)[0], status: 'answered', answer: 'đã có' },
    ];

    const next = applyAnswerToPending(queue, 'cùng một đáp án');

    expect(next.map((item) => [item.frame_id, item.status, item.answer])).toEqual([
      [1, 'answered', 'cùng một đáp án'],
      [2, 'answered', 'đã có'],
    ]);
  });

  it('overwrites every queue item when one answer is applied to all frames', () => {
    const queue: VqaQueueItem[] = [
      { ...fillVqaQueue([], [frame(1)], 100)[0], status: 'pending' },
      { ...fillVqaQueue([], [frame(2)], 100)[0], status: 'answered', answer: 'đáp án cũ' },
    ];

    expect(applyAnswerToAll(queue, 'đáp án chung').map((item) => item.answer)).toEqual([
      'đáp án chung',
      'đáp án chung',
    ]);
  });

  it('converts only answered queue items to submission answers in queue order', () => {
    const queue = fillVqaQueue([], [frame(1), frame(2)], 100);
    const answered = applyAnswerToPending(queue, 'answer');

    expect(completedVqaAnswers(answered)).toEqual([
      { video_id: 'video_1', frame_id: 1, answer: 'answer' },
      { video_id: 'video_2', frame_id: 2, answer: 'answer' },
    ]);
  });

  it('records answered, unknown, and failed batch results without losing their status', () => {
    const results: VqaBatchResult[] = [
      { frame: frame(1), status: 'answered', answer: 'một chiếc chai' },
      { frame: frame(2), status: 'abstained', answer: 'Không biết' },
      { frame: frame(3), status: 'error', error: 'timeout' },
    ];

    const next = applyVqaBatchResults([], results);

    expect(next.map((item) => [item.frame_id, item.status, item.answer, item.error])).toEqual([
      [1, 'answered', 'một chiếc chai', undefined],
      [2, 'abstained', 'Không biết', undefined],
      [3, 'error', undefined, 'timeout'],
    ]);
  });

  it('identifies the majority answer and automatically populates remaining frames up to 100', () => {
    const frames = Array.from({ length: 100 }, (_, idx) => frame(idx));
    const results: VqaBatchResult[] = [
      { frame: frame(0), status: 'answered', answer: 'màu đỏ' },
      { frame: frame(1), status: 'answered', answer: 'màu xanh' },
      { frame: frame(2), status: 'answered', answer: 'màu đỏ' },
      { frame: frame(3), status: 'abstained', answer: 'Không biết' },
      { frame: frame(4), status: 'answered', answer: 'màu đỏ' },
    ];

    const { updatedQueue, majorityAnswer, filledRemainingCount } = autoFillVqaQueueWithMajority(
      [],
      frames,
      results,
      100,
    );

    expect(majorityAnswer).toBe('màu đỏ');
    expect(updatedQueue).toHaveLength(100);
    expect(filledRemainingCount).toBe(96); // 1 abstained + 95 remaining frames
    expect(updatedQueue.every((item) => item.status === 'answered')).toBe(true);
    expect(updatedQueue[1]?.answer).toBe('màu xanh'); // preserved individual answer
    expect(updatedQueue[0]?.answer).toBe('màu đỏ');
    expect(updatedQueue[99]?.answer).toBe('màu đỏ'); // populated with majority
  });
});
