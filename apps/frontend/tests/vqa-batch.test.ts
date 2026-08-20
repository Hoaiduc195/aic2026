import { describe, expect, it, vi } from 'vitest';

import type { FrameCandidate, VqaAnswerSuggestion } from '@/lib/contracts';
import { runVqaBatch } from '@/lib/vqa-batch';

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

function answered(frameIndex: number): VqaAnswerSuggestion {
  return {
    result_id: `result-${frameIndex}`,
    query_id: 'query-1',
    video_id: `video_${frameIndex}`,
    original_frame_id: frameIndex,
    timestamp_ms: frameIndex * 1_000,
    answer_status: 'answered',
    answer: `answer-${frameIndex}`,
    normalized_answer: `answer-${frameIndex}`,
    evidence_ids: [],
    confidence: { level: 'high', score: 0.9 },
    producer: 'test',
    model_version: 'test',
  };
}

function unknown(frameIndex: number): VqaAnswerSuggestion {
  return {
    ...answered(frameIndex),
    answer_status: 'abstained',
    answer: 'Không biết',
    normalized_answer: 'Không biết',
    confidence: { level: 'low', score: 0 },
  };
}

describe('VQA batch runner', () => {
  it('runs requests concurrently within the configured worker limit and preserves frame order', async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const answer = vi.fn(async (candidate: FrameCandidate) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, candidate.original_frame_id === 1 ? 10 : 0));
      activeRequests -= 1;
      return answered(candidate.original_frame_id);
    });

    const result = await runVqaBatch({
      frames: [frame(1), frame(2), frame(3), frame(4)],
      limit: 4,
      concurrency: 2,
      answer,
    });

    expect(maxActiveRequests).toBe(2);
    expect(result.map((item) => item.frame.original_frame_id)).toEqual([1, 2, 3, 4]);
  });

  it('uses only the top K frames in the supplied order', async () => {
    const answer = vi.fn(async (candidate: FrameCandidate) => answered(candidate.original_frame_id));

    const result = await runVqaBatch({ frames: [frame(3), frame(1), frame(2)], limit: 2, answer });

    expect(answer.mock.calls.map(([candidate]) => candidate.original_frame_id)).toEqual([3, 1]);
    expect(result.map((item) => item.frame.original_frame_id)).toEqual([3, 1]);
  });

  it('spaces request starts by the configured delay while retaining the worker pool', async () => {
    const starts: number[] = [];
    const answer = vi.fn(async (candidate: FrameCandidate) => {
      starts.push(Date.now());
      return answered(candidate.original_frame_id);
    });

    await runVqaBatch({
      frames: [frame(1), frame(2), frame(3)],
      limit: 3,
      concurrency: 2,
      requestDelayMs: 25,
      answer,
    });

    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(20);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(20);
  });

  it('continues processing after a failed frame request', async () => {
    const answer = vi.fn(async (candidate: FrameCandidate) => {
      if (candidate.original_frame_id === 1) throw new Error('timeout');
      return answered(candidate.original_frame_id);
    });

    const result = await runVqaBatch({ frames: [frame(1), frame(2)], limit: 2, answer });

    expect(result.map((item) => item.status)).toEqual(['error', 'answered']);
    expect(result[0].error).toBe('timeout');
  });

  it('keeps the explicit Vietnamese unknown answer for an abstained frame', async () => {
    const result = await runVqaBatch({
      frames: [frame(1)],
      limit: 1,
      answer: vi.fn(async () => unknown(1)),
    });

    expect(result[0]).toMatchObject({ status: 'abstained', answer: 'Không biết' });
  });

  it('reports progress and skips targets selected by the caller', async () => {
    const progress: number[] = [];
    const answer = vi.fn(async (candidate: FrameCandidate) => answered(candidate.original_frame_id));

    const result = await runVqaBatch({
      frames: [frame(1), frame(2)],
      limit: 2,
      shouldSkip: (candidate) => candidate.original_frame_id === 1,
      answer,
      onProgress: ({ completed }) => progress.push(completed),
    });

    expect(answer).toHaveBeenCalledTimes(1);
    expect(result.map((item) => item.status)).toEqual(['skipped', 'answered']);
    expect(progress).toEqual([0, 1, 2]);
  });
});
