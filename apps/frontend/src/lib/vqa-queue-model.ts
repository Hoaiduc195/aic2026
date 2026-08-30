import type { FrameCandidate, QaAnswer } from './contracts';
import type { VqaBatchResult } from './vqa-batch';

export const VQA_QUEUE_LIMIT = 100;

export type VqaQueueStatus = 'pending' | 'answered' | 'abstained' | 'needs_more_evidence' | 'error';

export interface VqaQueueItem {
  readonly key: string;
  readonly video_id: string;
  readonly frame_id: number;
  readonly thumbnail_uri: string;
  readonly status: VqaQueueStatus;
  readonly answer?: string;
  readonly error?: string;
}

export function queueKey(frame: Pick<FrameCandidate, 'video_id' | 'original_frame_id'>): string {
  return `${frame.video_id}\u0000${frame.original_frame_id}`;
}

function limitValue(value: number): number {
  if (!Number.isFinite(value)) return VQA_QUEUE_LIMIT;
  return Math.max(0, Math.min(VQA_QUEUE_LIMIT, Math.floor(value)));
}

function itemFromFrame(frame: FrameCandidate): VqaQueueItem {
  return {
    key: queueKey(frame),
    video_id: frame.video_id,
    frame_id: frame.original_frame_id,
    thumbnail_uri: frame.thumbnail_uri,
    status: 'pending',
  };
}

function deduplicateQueue(items: readonly VqaQueueItem[]): VqaQueueItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  }).map((item) => ({ ...item }));
}

export function fillVqaQueue(
  existing: readonly VqaQueueItem[],
  frames: readonly FrameCandidate[],
  limit = VQA_QUEUE_LIMIT,
): VqaQueueItem[] {
  const maxItems = limitValue(limit);
  const current = deduplicateQueue(existing);
  const known = new Set(current.map((item) => item.key));
  const additions = frames
    .filter((frame) => {
      const key = queueKey(frame);
      if (known.has(key)) return false;
      known.add(key);
      return true;
    })
    .map((frame) => itemFromFrame(frame));

  return [...current, ...additions].slice(0, maxItems);
}

export function restoreVqaQueueFromAnswers(
  answers: readonly QaAnswer[],
  candidates: readonly FrameCandidate[],
  limit = VQA_QUEUE_LIMIT,
): VqaQueueItem[] {
  const maxItems = limitValue(limit);
  const candidatesByKey = new Map(candidates.map((frame) => [queueKey(frame), frame] as const));
  const seen = new Set<string>();

  return answers.flatMap((answer) => {
    const frame = candidatesByKey.get(queueKey({
      video_id: answer.video_id,
      original_frame_id: answer.frame_id,
    }));
    const answerText = answer.answer;
    if (!frame || !answerText.trim()) return [];

    const key = queueKey(frame);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      ...itemFromFrame(frame),
      status: 'answered' as const,
      answer: answerText,
    }];
  }).slice(0, maxItems);
}

export function addVqaFrame(
  existing: readonly VqaQueueItem[],
  frame: FrameCandidate,
  limit = VQA_QUEUE_LIMIT,
): VqaQueueItem[] {
  const current = deduplicateQueue(existing);
  const key = queueKey(frame);
  if (current.some((item) => item.key === key)) return current;
  if (current.length >= limitValue(limit)) return current;
  return [...current, itemFromFrame(frame)];
}

export function applyAnswerToPending(
  existing: readonly VqaQueueItem[],
  answer: string,
): VqaQueueItem[] {
  if (!answer.trim()) return existing.map((item) => ({ ...item }));
  return existing.map((item) => item.status !== 'answered'
    ? { ...item, status: 'answered', answer, error: undefined }
    : { ...item });
}

export function applyAnswerToAll(
  existing: readonly VqaQueueItem[],
  answer: string,
): VqaQueueItem[] {
  if (!answer.trim()) return existing.map((item) => ({ ...item }));
  return existing.map((item) => ({
    ...item,
    status: 'answered',
    answer,
    error: undefined,
  }));
}

export function applyVqaBatchResults(
  existing: readonly VqaQueueItem[],
  results: readonly VqaBatchResult[],
): VqaQueueItem[] {
  return results.reduce((current, result) => {
    if (result.status === 'skipped') return current.map((item) => ({ ...item }));

    const withFrame = addVqaFrame(current, result.frame);
    const answer = result.answer?.trim();
    if (result.status === 'answered' && answer) {
      return updateVqaQueueItem(withFrame, queueKey(result.frame), { status: 'answered', answer });
    }

    if (result.status === 'needs_more_evidence' || result.status === 'abstained' || result.status === 'answered') {
      return updateVqaQueueItem(withFrame, queueKey(result.frame), {
        status: result.status === 'needs_more_evidence' ? 'needs_more_evidence' : 'abstained',
        answer: answer || 'Không biết',
      });
    }

    return updateVqaQueueItem(withFrame, queueKey(result.frame), {
      status: 'error',
      error: result.error?.trim() || 'Không thể trả lời frame này.',
    });
  }, existing.map((item) => ({ ...item })));
}

export function updateVqaQueueItem(
  existing: readonly VqaQueueItem[],
  key: string,
  update: Pick<VqaQueueItem, 'status'> & Partial<Pick<VqaQueueItem, 'answer' | 'error'>>,
): VqaQueueItem[] {
  return existing.map((item) => item.key === key ? {
    ...item,
    ...update,
    ...(update.status === 'answered' ? { error: undefined } : {}),
  } : { ...item });
}

export function removeVqaQueueItem(existing: readonly VqaQueueItem[], key: string): VqaQueueItem[] {
  return existing.filter((item) => item.key !== key).map((item) => ({ ...item }));
}

export function moveVqaQueueItem(existing: readonly VqaQueueItem[], from: number, to: number): VqaQueueItem[] {
  if (from < 0 || from >= existing.length || to < 0 || to >= existing.length || from === to) {
    return existing.map((item) => ({ ...item }));
  }
  const next = existing.map((item) => ({ ...item }));
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function completedVqaAnswers(existing: readonly VqaQueueItem[]): QaAnswer[] {
  return existing
    .filter((item): item is VqaQueueItem & { readonly answer: string } => item.status === 'answered' && Boolean(item.answer?.trim()))
    .map((item) => ({ video_id: item.video_id, frame_id: item.frame_id, answer: item.answer }));
}

/**
 * Finds the most frequent valid answer from completed batch results.
 */
export function findMajorityVqaAnswer(
  results: readonly VqaBatchResult[],
): string | null {
  const counts = new Map<string, number>();
  for (const result of results) {
    if (result.status === 'answered' && result.answer?.trim() && result.answer.trim() !== 'Không biết') {
      const normalized = result.answer.trim();
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }
  let majorityAnswer: string | null = null;
  let maxCount = 0;
  for (const [answer, count] of counts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      majorityAnswer = answer;
    }
  }
  return majorityAnswer;
}

/**
 * Fills the VQA queue up to 100 frames from ranked candidates, applies batch results to top-k,
 * and automatically populates all remaining pending/unanswered frames with the majority answer.
 */
export function autoFillVqaQueueWithMajority(
  existing: readonly VqaQueueItem[],
  rankedFrames: readonly FrameCandidate[],
  batchResults: readonly VqaBatchResult[],
  limit = 100,
): { updatedQueue: VqaQueueItem[]; majorityAnswer: string | null; filledRemainingCount: number } {
  const filledQueue = fillVqaQueue(existing, rankedFrames, limit);
  const withBatch = applyVqaBatchResults(filledQueue, batchResults.filter((r) => r.status !== 'skipped'));
  const majorityAnswer = findMajorityVqaAnswer(batchResults);

  if (!majorityAnswer) {
    return { updatedQueue: withBatch, majorityAnswer: null, filledRemainingCount: 0 };
  }

  let filledRemainingCount = 0;
  const finalQueue = withBatch.map((item) => {
    if (item.status !== 'answered') {
      filledRemainingCount += 1;
      return {
        ...item,
        status: 'answered' as const,
        answer: majorityAnswer,
        error: undefined,
      };
    }
    return item;
  });

  return { updatedQueue: finalQueue, majorityAnswer, filledRemainingCount };
}

