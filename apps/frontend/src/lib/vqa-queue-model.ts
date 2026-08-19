import type { FrameCandidate, QaAnswer } from './contracts';

export const VQA_QUEUE_LIMIT = 100;

export type VqaQueueStatus = 'pending' | 'answered' | 'error';

export interface VqaQueueItem {
  readonly key: string;
  readonly video_id: string;
  readonly frame_id: number;
  readonly thumbnail_uri: string;
  readonly status: VqaQueueStatus;
  readonly answer?: string;
  readonly error?: string;
  readonly downvoted: boolean;
}

export function queueKey(frame: Pick<FrameCandidate, 'video_id' | 'original_frame_id'>): string {
  return `${frame.video_id}\u0000${frame.original_frame_id}`;
}

function limitValue(value: number): number {
  if (!Number.isFinite(value)) return VQA_QUEUE_LIMIT;
  return Math.max(0, Math.min(VQA_QUEUE_LIMIT, Math.floor(value)));
}

function itemFromFrame(frame: FrameCandidate, downvoted = false): VqaQueueItem {
  return {
    key: queueKey(frame),
    video_id: frame.video_id,
    frame_id: frame.original_frame_id,
    thumbnail_uri: frame.thumbnail_uri,
    status: 'pending',
    downvoted,
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

function rankDownvoted(items: readonly VqaQueueItem[]): VqaQueueItem[] {
  return [
    ...items.filter((item) => !item.downvoted),
    ...items.filter((item) => item.downvoted),
  ];
}

export function fillVqaQueue(
  existing: readonly VqaQueueItem[],
  frames: readonly FrameCandidate[],
  downvotedKeys: ReadonlySet<string>,
  limit = VQA_QUEUE_LIMIT,
): VqaQueueItem[] {
  const maxItems = limitValue(limit);
  const current = deduplicateQueue(existing).map((item) => ({
    ...item,
    downvoted: downvotedKeys.has(item.key),
  }));
  const known = new Set(current.map((item) => item.key));
  const additions = frames
    .filter((frame) => {
      const key = queueKey(frame);
      if (known.has(key)) return false;
      known.add(key);
      return true;
    })
    .map((frame) => itemFromFrame(frame, downvotedKeys.has(queueKey(frame))));

  return rankDownvoted([...current, ...additions]).slice(0, maxItems);
}

export function addVqaFrame(
  existing: readonly VqaQueueItem[],
  frame: FrameCandidate,
  downvoted: boolean,
  limit = VQA_QUEUE_LIMIT,
): VqaQueueItem[] {
  const current = deduplicateQueue(existing);
  const key = queueKey(frame);
  const existingItem = current.find((item) => item.key === key);
  if (existingItem) {
    return current.map((item) => item.key === key ? { ...item, downvoted } : item);
  }
  if (current.length >= limitValue(limit)) return current;
  return [...current, itemFromFrame(frame, downvoted)];
}

export function toggleVqaQueueDownvote(
  existing: readonly VqaQueueItem[],
  key: string,
  downvoted: boolean,
): VqaQueueItem[] {
  return rankDownvoted(existing.map((item) => item.key === key ? { ...item, downvoted } : { ...item }));
}

export function applyAnswerToPending(
  existing: readonly VqaQueueItem[],
  answer: string,
): VqaQueueItem[] {
  const normalized = answer.trim();
  if (!normalized) return existing.map((item) => ({ ...item }));
  return existing.map((item) => item.status === 'pending' || item.status === 'error'
    ? { ...item, status: 'answered', answer: normalized, error: undefined }
    : { ...item });
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
    .map((item) => ({ video_id: item.video_id, frame_id: item.frame_id, answer: item.answer.trim() }));
}
