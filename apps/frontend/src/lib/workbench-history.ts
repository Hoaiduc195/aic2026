import type {
  FrameCandidate,
  QualificationAnswer,
  QualificationEventInput,
  QualificationTask,
  SearchResponse,
} from './contracts';
import type { VqaQueueItem } from './vqa-queue-model';
import type { TrakeQueueItem } from './trake-queue-model';

export const WORKBENCH_SESSION_STORAGE_KEY = 'aic.workbench.session-id';
export const WORKBENCH_HISTORY_STORAGE_KEY = 'aic.workbench.history.v1';
export const MAX_WORKBENCH_HISTORY_ENTRIES = 50;

export interface WorkbenchSnapshot {
  readonly task: QualificationTask;
  readonly description: string;
  readonly question: string;
  readonly events: readonly QualificationEventInput[];
  readonly response: SearchResponse | null;
  readonly rankedFrames: readonly FrameCandidate[];
  readonly selectedAnchor: FrameCandidate | null;
  readonly assignedFrames: readonly (FrameCandidate | null)[];
  /** TRAKE selections keyed by the result/object list they belong to. */
  readonly assignedFramesByResult?: Readonly<Record<string, readonly (FrameCandidate | null)[]>>;
  readonly answers: readonly QualificationAnswer[];
  readonly qaAnswer: string;
  readonly vqaQueue: readonly VqaQueueItem[];
  readonly trakeQueue?: readonly TrakeQueueItem[];
}

export interface WorkbenchHistoryEntry extends WorkbenchSnapshot {
  readonly history_id: string;
  readonly created_at: string;
  readonly label: string;
}

function browserStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

function randomId(prefix: string): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

function snapshotLabel(snapshot: WorkbenchSnapshot): string {
  const firstEvent = snapshot.events.find((event) => event.description.trim())?.description.trim();
  if (snapshot.response?.query_mode === 'frame_image' || snapshot.response?.query_mode === 'exact_frames') {
    const result = snapshot.response.results[0];
    return result
      ? `Frame ${result.video_id} · ${result.original_frame_id ?? result.start_ms}`
      : 'Query bằng frame';
  }
  return snapshot.description.trim() || snapshot.question.trim() || firstEvent || 'Query frame';
}

function isTask(value: unknown): value is QualificationTask {
  return value === 'textual_kis' || value === 'qa' || value === 'trake';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAssignedFramesByResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((frames) => Array.isArray(frames));
}

function isTrakeQueue(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => (
    isRecord(item)
    && typeof item.key === 'string'
    && isRecord(item.anchor)
    && Array.isArray(item.frames)
  ));
}

function isHistoryEntry(value: unknown): value is WorkbenchHistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<WorkbenchHistoryEntry>;
  return typeof entry.history_id === 'string'
    && typeof entry.created_at === 'string'
    && typeof entry.label === 'string'
    && isTask(entry.task)
    && typeof entry.description === 'string'
    && typeof entry.question === 'string'
    && Array.isArray(entry.events)
    && (entry.response === null || typeof entry.response === 'object')
    && Array.isArray(entry.rankedFrames)
    && (entry.selectedAnchor === null || typeof entry.selectedAnchor === 'object')
    && Array.isArray(entry.assignedFrames)
    && (entry.assignedFramesByResult === undefined || isAssignedFramesByResult(entry.assignedFramesByResult))
    && Array.isArray(entry.answers)
    && typeof entry.qaAnswer === 'string'
    && Array.isArray(entry.vqaQueue)
    && (entry.trakeQueue === undefined || isTrakeQueue(entry.trakeQueue));
}

function sortHistoryEntriesByRecency(entries: readonly WorkbenchHistoryEntry[]): WorkbenchHistoryEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, timestamp: Date.parse(entry.created_at) }))
    .sort((left, right) => {
      const leftValid = Number.isFinite(left.timestamp);
      const rightValid = Number.isFinite(right.timestamp);
      if (!leftValid && !rightValid) return left.index - right.index;
      if (!leftValid) return 1;
      if (!rightValid) return -1;
      return right.timestamp - left.timestamp || left.index - right.index;
    })
    .map(({ entry }) => entry);
}

export function getOrCreateWorkbenchSessionId(storage?: Storage): string {
  const target = browserStorage(storage);
  if (!target) return randomId('workbench-session');

  try {
    const existing = target.getItem(WORKBENCH_SESSION_STORAGE_KEY)?.trim();
    if (existing) return existing;
    const created = randomId('workbench-session');
    target.setItem(WORKBENCH_SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return randomId('workbench-session');
  }
}

export function createWorkbenchHistoryEntry(
  snapshot: WorkbenchSnapshot,
  createdAt = new Date(),
  historyId = randomId('workbench-history'),
): WorkbenchHistoryEntry {
  return {
    ...snapshot,
    events: snapshot.events.map((event) => ({ ...event })),
    rankedFrames: [...snapshot.rankedFrames],
    assignedFrames: [...snapshot.assignedFrames],
    ...(snapshot.assignedFramesByResult
      ? {
        assignedFramesByResult: Object.fromEntries(
          Object.entries(snapshot.assignedFramesByResult).map(([resultKey, frames]) => [resultKey, [...frames]]),
        ),
      }
      : {}),
    answers: snapshot.answers.map((answer) => ({ ...answer })),
    vqaQueue: snapshot.vqaQueue.map((item) => ({ ...item })),
    ...(snapshot.trakeQueue
      ? {
        trakeQueue: snapshot.trakeQueue.map((item) => ({
          key: item.key,
          anchor: { ...item.anchor },
          frames: item.frames.map((frame) => ({ ...frame })),
        })),
      }
      : {}),
    history_id: historyId,
    created_at: createdAt.toISOString(),
    label: snapshotLabel(snapshot),
  };
}

export function loadWorkbenchHistory(storage?: Storage): WorkbenchHistoryEntry[] {
  const target = browserStorage(storage);
  if (!target) return [];

  try {
    const raw = target.getItem(WORKBENCH_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? sortHistoryEntriesByRecency(parsed.filter(isHistoryEntry)).slice(0, MAX_WORKBENCH_HISTORY_ENTRIES)
      : [];
  } catch {
    return [];
  }
}

export function saveWorkbenchHistoryEntry(entry: WorkbenchHistoryEntry, storage?: Storage): void {
  const target = browserStorage(storage);
  if (!target) return;

  const entries = [entry, ...loadWorkbenchHistory(target).filter((item) => item.history_id !== entry.history_id)]
    .slice(0, MAX_WORKBENCH_HISTORY_ENTRIES);
  try {
    target.setItem(WORKBENCH_HISTORY_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // A full or unavailable localStorage must not block searching.
  }
}

export function removeWorkbenchHistoryEntry(historyId: string, storage?: Storage): void {
  const target = browserStorage(storage);
  if (!target) return;
  try {
    target.setItem(
      WORKBENCH_HISTORY_STORAGE_KEY,
      JSON.stringify(loadWorkbenchHistory(target).filter((entry) => entry.history_id !== historyId)),
    );
  } catch {
    // A full or unavailable localStorage must not block the workbench.
  }
}

export function clearWorkbenchHistory(storage?: Storage): void {
  const target = browserStorage(storage);
  if (!target) return;
  try {
    target.removeItem(WORKBENCH_HISTORY_STORAGE_KEY);
  } catch {
    // A disabled localStorage must not block the workbench.
  }
}
