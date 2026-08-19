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
  readonly shouldSkip?: (frame: FrameCandidate) => boolean;
  readonly intervalMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: VqaBatchProgress) => void;
}

const MAX_BATCH_SIZE = 100;

function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.min(MAX_BATCH_SIZE, Math.floor(limit)));
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(value: unknown): string {
  return value instanceof Error && value.message ? value.message : 'Không thể trả lời frame này.';
}

export async function runVqaBatch(options: RunVqaBatchOptions): Promise<VqaBatchResult[]> {
  const frames = options.frames.slice(0, boundedLimit(options.limit));
  const results: VqaBatchResult[] = [];
  const wait = options.wait ?? defaultWait;
  const intervalMs = Math.max(0, Math.floor(options.intervalMs ?? 0));
  let requestCount = 0;
  let failed = 0;

  const report = () => options.onProgress?.({ completed: results.length, total: frames.length, failed });
  report();

  for (const frame of frames) {
    if (options.signal?.aborted) break;
    if (options.shouldSkip?.(frame)) {
      results.push({ frame, status: 'skipped' });
      report();
      continue;
    }
    if (requestCount > 0 && intervalMs > 0) {
      await wait(intervalMs);
      if (options.signal?.aborted) break;
    }
    requestCount += 1;
    try {
      const suggestion = await options.answer(frame);
      const status = suggestion.answer_status === 'answered' && suggestion.answer?.trim()
        ? 'answered'
        : suggestion.answer_status;
      results.push({
        frame,
        status,
        suggestion,
        ...(suggestion.answer?.trim() ? { answer: suggestion.answer.trim() } : {}),
      });
    } catch (error) {
      failed += 1;
      results.push({ frame, status: 'error', error: errorMessage(error) });
    }
    report();
  }

  return results;
}
