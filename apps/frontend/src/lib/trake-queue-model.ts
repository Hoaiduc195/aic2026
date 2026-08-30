import type { FrameCandidate, TrakeAnswer } from './contracts';
import { TRAKE_FRAME_COUNT, validateTrakeSequence, sortTrakeFrames } from './workbench-model';

export const TRAKE_QUEUE_LIMIT = 100;

export interface TrakeQueueItem {
  readonly key: string;
  readonly anchor: FrameCandidate;
  readonly frames: readonly FrameCandidate[];
}

export function trakeQueueKey(frame: Pick<FrameCandidate, 'video_id' | 'original_frame_id'>): string {
  return `${frame.video_id}\u0000${frame.original_frame_id}`;
}

export function createTrakeQueueItem(anchor: FrameCandidate): TrakeQueueItem {
  return { key: trakeQueueKey(anchor), anchor: { ...anchor }, frames: [] };
}

export function fillTrakeQueue(
  existing: readonly TrakeQueueItem[],
  anchors: readonly FrameCandidate[],
  limit = TRAKE_QUEUE_LIMIT,
): TrakeQueueItem[] {
  const maxItems = Math.max(0, Math.min(TRAKE_QUEUE_LIMIT, Math.floor(limit)));
  const current = deduplicateItems(existing);
  const known = new Set(current.map((item) => item.key));
  const additions = anchors.flatMap((anchor) => {
    const key = trakeQueueKey(anchor);
    if (known.has(key)) return [];
    known.add(key);
    return [createTrakeQueueItem(anchor)];
  });
  return [...current, ...additions].slice(0, maxItems);
}

export function completeTrakeQueueItem(
  item: TrakeQueueItem,
  frames: readonly FrameCandidate[],
  requiredFrameCount = TRAKE_FRAME_COUNT,
): TrakeQueueItem {
  const normalized = sortTrakeFrames(frames);
  return validateTrakeSequence(normalized, requiredFrameCount)
    ? { ...item, frames: normalized.map((frame) => ({ ...frame })) }
    : { ...item, frames: [] };
}

export function updateTrakeQueueItem(
  existing: readonly TrakeQueueItem[],
  key: string,
  frames: readonly FrameCandidate[],
  requiredFrameCount = TRAKE_FRAME_COUNT,
): TrakeQueueItem[] {
  return existing.map((item) => item.key === key ? completeTrakeQueueItem(item, frames, requiredFrameCount) : cloneItem(item));
}

export function upsertCompletedTrakeQueueItem(
  existing: readonly TrakeQueueItem[],
  anchor: FrameCandidate,
  frames: readonly FrameCandidate[],
  limit = TRAKE_QUEUE_LIMIT,
  requiredFrameCount = TRAKE_FRAME_COUNT,
): TrakeQueueItem[] {
  const filled = fillTrakeQueue(existing, [anchor], limit);
  return updateTrakeQueueItem(filled, trakeQueueKey(anchor), frames, requiredFrameCount);
}

export function isCompleteTrakeQueueItem(item: TrakeQueueItem, requiredFrameCount = TRAKE_FRAME_COUNT): boolean {
  return item.frames.length === requiredFrameCount && validateTrakeSequence(item.frames, requiredFrameCount);
}

export function trakeQueueAnswers(
  items: readonly TrakeQueueItem[],
  requiredFrameCount = TRAKE_FRAME_COUNT,
): TrakeAnswer[] {
  return items
    .filter((item) => isCompleteTrakeQueueItem(item, requiredFrameCount))
    .map((item) => ({
      video_id: item.frames[0].video_id,
      frame_ids: item.frames.map((frame) => frame.original_frame_id),
    }));
}

/**
 * Migrates legacy complete TRAKE answers only when every referenced frame is
 * already available as a real candidate. Missing metadata is intentionally
 * not synthesized because a submission must never contain guessed frame IDs.
 */
export function restoreTrakeQueueFromAnswers(
  answers: readonly TrakeAnswer[],
  candidates: readonly FrameCandidate[],
): TrakeQueueItem[] {
  const candidatesByKey = new Map<string, FrameCandidate>();
  candidates.forEach((candidate) => {
    const key = trakeQueueKey(candidate);
    if (!candidatesByKey.has(key)) candidatesByKey.set(key, candidate);
  });

  const seen = new Set<string>();
  return answers.flatMap((answer) => {
    const frames = answer.frame_ids.map((frameId) => candidatesByKey.get(trakeQueueKey({
      video_id: answer.video_id,
      original_frame_id: frameId,
    })));
    if (frames.some((frame) => !frame)) return [];
    const resolvedFrames = frames.filter((frame): frame is FrameCandidate => frame !== undefined);
    const anchor = resolvedFrames[0];
    if (!anchor) return [];
    const item = completeTrakeQueueItem({
      key: trakeQueueKey(anchor),
      anchor: { ...anchor },
      frames: [],
    }, resolvedFrames, answer.frame_ids.length);
    if (!isCompleteTrakeQueueItem(item, answer.frame_ids.length) || seen.has(item.key)) return [];
    seen.add(item.key);
    return [item];
  });
}

export function incompleteTrakeQueueCount(
  items: readonly TrakeQueueItem[],
  requiredFrameCount = TRAKE_FRAME_COUNT,
): number {
  return items.filter((item) => !isCompleteTrakeQueueItem(item, requiredFrameCount)).length;
}

export function removeTrakeQueueItem(existing: readonly TrakeQueueItem[], key: string): TrakeQueueItem[] {
  return existing.filter((item) => item.key !== key).map(cloneItem);
}

export function moveTrakeQueueItem(existing: readonly TrakeQueueItem[], from: number, to: number): TrakeQueueItem[] {
  if (from < 0 || from >= existing.length || to < 0 || to >= existing.length || from === to) {
    return existing.map(cloneItem);
  }
  const next = existing.map(cloneItem);
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function deduplicateItems(items: readonly TrakeQueueItem[]): TrakeQueueItem[] {
  const seen = new Set<string>();
  return items.flatMap((item) => {
    if (seen.has(item.key)) return [];
    seen.add(item.key);
    return [cloneItem(item)];
  });
}

function cloneItem(item: TrakeQueueItem): TrakeQueueItem {
  return {
    key: item.key,
    anchor: { ...item.anchor },
    frames: item.frames.map((frame) => ({ ...frame })),
  };
}
