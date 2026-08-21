import type { FrameCandidate, VqaAnswerSuggestion } from './contracts';

export type VqaBatchItemStatus = 'answered' | 'needs_more_evidence' | 'abstained' | 'error' | 'skipped';

export interface VqaBatchResult {
  readonly frame: FrameCandidate;
  readonly status: VqaBatchItemStatus;
  readonly answer?: string;
  readonly error?: string;
  readonly suggestion?: VqaAnswerSuggestion;
}

export interface VqaBatchProgress {
  readonly completed: number;
  readonly total: number;
  readonly failed: number;
}

export interface RunVqaBatchOptions {
  readonly frames: readonly FrameCandidate[];
  readonly limit: number;
  readonly answer: (frame: FrameCandidate) => Promise<VqaAnswerSuggestion>;
  readonly concurrency?: number;
  readonly requestDelayMs?: number;
  readonly shouldSkip?: (frame: FrameCandidate) => boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: VqaBatchProgress) => void;
}

const MAX_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.min(MAX_BATCH_SIZE, Math.floor(limit)));
}

function boundedConcurrency(concurrency: number | undefined): number {
  if (!Number.isFinite(concurrency)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(concurrency as number)));
}

function boundedRequestDelay(delayMs: number | undefined): number {
  if (!Number.isFinite(delayMs)) return 0;
  return Math.max(0, Math.min(5_000, Math.floor(delayMs as number)));
}

function errorMessage(value: unknown): string {
  return value instanceof Error && value.message ? value.message : 'Không thể trả lời frame này.';
}

export async function runVqaBatch(options: RunVqaBatchOptions): Promise<VqaBatchResult[]> {
  const frames = options.frames.slice(0, boundedLimit(options.limit));
  const concurrency = boundedConcurrency(options.concurrency);
  const requestDelayMs = boundedRequestDelay(options.requestDelayMs);
  const skipped: { readonly index: number; readonly result: VqaBatchResult }[] = [];
  const pending: { readonly frame: FrameCandidate; readonly index: number }[] = [];
  for (const [index, frame] of frames.entries()) {
    if (options.shouldSkip?.(frame)) skipped.push({ index, result: { frame, status: 'skipped' } });
    else pending.push({ frame, index });
  }

  const completedResults: { readonly index: number; readonly result: VqaBatchResult }[] = [];
  let failed = 0;
  let completed = 0;

  const report = () => options.onProgress?.({ completed, total: frames.length, failed });
  report();

  for (const item of skipped) {
    completedResults.push(item);
    completed += 1;
    report();
  }

  let nextPendingIndex = 0;
  let nextRequestAt = 0;
  let requestSlotQueue = Promise.resolve();

  async function acquireRequestSlot(): Promise<boolean> {
    let release!: () => void;
    const previous = requestSlotQueue;
    requestSlotQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      if (options.signal?.aborted) return false;
      const waitMs = Math.max(0, nextRequestAt - Date.now());
      if (waitMs > 0 && !(await waitForRequestDelay(waitMs, options.signal))) return false;
      if (options.signal?.aborted) return false;
      nextRequestAt = Date.now() + requestDelayMs;
      return true;
    } finally {
      release();
    }
  }

  async function worker(): Promise<void> {
    while (!options.signal?.aborted) {
      const pendingIndex = nextPendingIndex;
      nextPendingIndex += 1;
      const item = pending[pendingIndex];
      if (!item) return;
      if (!(await acquireRequestSlot())) return;

      let result: VqaBatchResult;
      try {
        const suggestion = await options.answer(item.frame);
        const status = suggestion.answer_status === 'answered' && suggestion.answer?.trim()
          ? 'answered'
          : suggestion.answer_status;
        result = {
          frame: item.frame,
          status,
          suggestion,
          ...(suggestion.answer?.trim() ? { answer: suggestion.answer.trim() } : {}),
        };
      } catch (error) {
        failed += 1;
        result = { frame: item.frame, status: 'error', error: errorMessage(error) };
      }
      completedResults.push({ index: item.index, result });
      completed += 1;
      report();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));

  return completedResults
    .sort((left, right) => left.index - right.index)
    .map(({ result }) => result);
}

function waitForRequestDelay(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (delayMs <= 0) return Promise.resolve(!signal?.aborted);

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: boolean) => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(true), delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
