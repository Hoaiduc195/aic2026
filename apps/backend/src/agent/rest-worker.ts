import 'dotenv/config';

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { OpenAICompatibleVisionClient } from '../compute/vlm-vision.client';

type Task = 'textual_kis' | 'vqa' | 'trake';
type PrefilterRoute = 'auto_reject' | 'auto_accept' | 'vlm_review';

interface WorkerOptions {
  readonly query?: string;
  readonly runId?: string;
  readonly task: Task;
  readonly topK: number;
  readonly videoBudget: number;
  readonly frameBatchSize: number;
  readonly workerId: string;
  readonly backendUrl: string;
  readonly operatorToken?: string;
  readonly leaseMs: number;
  readonly vlmConcurrency: number;
  readonly maxBatches: number;
  readonly statePath: string;
}

export interface BatchFrame {
  readonly video_id: string;
  readonly original_frame_id: number;
  readonly thumbnail_uri: string;
  readonly clip_score: number | null;
  readonly prefilter_route: PrefilterRoute;
}

interface RunSummary {
  readonly run_id: string;
  readonly query: string;
  readonly status: 'running' | 'completed' | 'stopped' | 'failed';
  readonly frames_examined: number;
  readonly frames_total: number;
  readonly videos_examined: number;
  readonly videos_total: number;
  readonly coverage_ratio: number;
}

interface BatchResponse {
  readonly run: RunSummary;
  readonly batch: null | { readonly frames: readonly BatchFrame[] };
}

interface Judgment {
  readonly video_id: string;
  readonly original_frame_id: number;
  readonly relevant: boolean;
  readonly score: number;
  readonly reason: string;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`expected integer between ${minimum} and ${maximum}, received ${value ?? fallback}`);
  }
  return parsed;
}

function argumentsMap(args: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) continue;
    const [name, inlineValue] = token.slice(2).split('=', 2);
    const next = args[index + 1];
    if (inlineValue !== undefined) result.set(name, inlineValue);
    else if (next && !next.startsWith('--')) {
      result.set(name, next);
      index += 1;
    } else result.set(name, 'true');
  }
  return result;
}

function parseOptions(args: readonly string[]): WorkerOptions {
  const values = argumentsMap(args);
  const task = values.get('task') ?? 'textual_kis';
  if (!['textual_kis', 'vqa', 'trake'].includes(task)) throw new Error('task must be textual_kis, vqa or trake');
  const workerId = values.get('worker-id') ?? `worker-${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(workerId)) throw new Error('worker-id is invalid');
  const runId = values.get('run-id');
  const query = values.get('query');
  if (!runId && !query?.trim()) throw new Error('--query is required when --run-id is not supplied');
  const statePath = values.get('state-path') ?? resolve(
    process.cwd(), '../../data/tmp/agent-worker', `${workerId}.json`,
  );
  return {
    query: query?.trim(),
    runId,
    task: task as Task,
    topK: integer(values.get('top-k'), 20, 1, 100),
    videoBudget: integer(values.get('video-budget'), 10, 1, 50),
    frameBatchSize: integer(values.get('batch-size'), 8, 1, 32),
    workerId,
    backendUrl: (process.env.BACKEND_URL?.trim() || 'http://localhost:4000').replace(/\/+$/, ''),
    operatorToken: process.env.BACKEND_OPERATOR_TOKEN?.trim() || process.env.OPERATOR_TOKEN?.trim() || undefined,
    leaseMs: integer(process.env.AGENT_WORKER_LEASE_MS, 60_000, 10_000, 300_000),
    vlmConcurrency: integer(process.env.AGENT_WORKER_VLM_CONCURRENCY, 2, 1, 8),
    maxBatches: integer(values.get('max-batches'), 0, 0, 100_000),
    statePath,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class NonRetryableHttpError extends Error {}

class RestClient {
  constructor(private readonly options: WorkerOptions) {}

  async json<T>(path: string, init: RequestInit = {}, retries = 4): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(`${this.options.backendUrl}${path}`, {
          ...init,
          headers: {
            'content-type': 'application/json',
            'x-agent-worker-id': this.options.workerId,
            ...(this.options.operatorToken ? { 'x-operator-token': this.options.operatorToken } : {}),
            ...(init.headers ?? {}),
          },
          signal: AbortSignal.timeout(30_000),
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok) return payload as T;
        if (response.status < 500 && response.status !== 408 && response.status !== 429) {
          throw new NonRetryableHttpError(`backend HTTP ${response.status}: ${JSON.stringify(payload)}`);
        }
        lastError = new Error(`backend HTTP ${response.status}`);
      } catch (error) {
        if (error instanceof NonRetryableHttpError) throw error;
        lastError = error;
      }
      if (attempt < retries) await delay(Math.min(8_000, 500 * (2 ** attempt)));
    }
    throw lastError instanceof Error ? lastError : new Error('backend request failed');
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await operation(values[index]);
    }
  });
  await Promise.all(runners);
  return result;
}

async function writeState(path: string, state: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

function createVlm(): OpenAICompatibleVisionClient {
  const baseUrl = process.env.VLM_BASE_URL?.trim() || process.env.LLM_BASE_URL?.trim();
  const model = process.env.AGENT_WORKER_VLM_MODEL?.trim()
    || process.env.VLM_MODEL?.trim()
    || process.env.LLM_MODEL?.trim();
  if (!baseUrl || !model) throw new Error('VLM_BASE_URL and VLM_MODEL are required for agent worker');
  return new OpenAICompatibleVisionClient({
    baseUrl,
    model,
    apiKey: process.env.VLM_API_KEY?.trim() || process.env.LLM_API_KEY?.trim() || undefined,
    timeoutMs: integer(
      process.env.AGENT_WORKER_VLM_TIMEOUT_MS ?? process.env.VLM_TIMEOUT_MS,
      45_000,
      1_000,
      120_000,
    ),
    maxTokens: integer(process.env.AGENT_WORKER_VLM_MAX_TOKENS ?? process.env.LLM_MAX_TOKENS, 128, 16, 4096),
    temperature: 0,
    retries: 2,
  });
}

export async function judgeBatch(
  frames: readonly BatchFrame[],
  query: string,
  vlm: Pick<OpenAICompatibleVisionClient, 'verifyImageRelevance'>,
  concurrency: number,
): Promise<Judgment[]> {
  return mapConcurrent(frames, concurrency, async (frame) => {
    if (frame.prefilter_route === 'auto_reject') {
      return {
        video_id: frame.video_id,
        original_frame_id: frame.original_frame_id,
        relevant: false,
        score: Math.max(0, Math.min(1, frame.clip_score ?? 0)),
        reason: `clip_auto_reject:${frame.clip_score ?? 'missing'}`,
      };
    }
    if (frame.prefilter_route === 'auto_accept') {
      return {
        video_id: frame.video_id,
        original_frame_id: frame.original_frame_id,
        relevant: true,
        score: Math.max(0, Math.min(1, frame.clip_score ?? 1)),
        reason: `clip_auto_accept:${frame.clip_score ?? 'missing'}`,
      };
    }
    const judged = await vlm.verifyImageRelevance({ query, imageUrl: frame.thumbnail_uri });
    return {
      video_id: frame.video_id,
      original_frame_id: frame.original_frame_id,
      relevant: judged.match,
      score: judged.score / 100,
      reason: `vlm:${judged.reason}`.slice(0, 200),
    };
  });
}

export async function runWorker(options: WorkerOptions): Promise<unknown> {
  const client = new RestClient(options);
  let runId = options.runId;
  let query = options.query;
  let initialRun: RunSummary | undefined;
  if (!runId) {
    const started = await client.json<{ run: RunSummary }>('/v1/agent/frame-search', {
      method: 'POST',
      body: JSON.stringify({
        query,
        task: options.task,
        top_k: options.topK,
        video_budget: options.videoBudget,
        frame_batch_size: options.frameBatchSize,
      }),
    });
    runId = started.run.run_id;
    initialRun = started.run;
  } else if (!query) {
    const status = await client.json<{ run: RunSummary }>(`/v1/agent/frame-search/${encodeURIComponent(runId)}`);
    query = status.run.query;
    initialRun = status.run;
  }

  if (initialRun?.status !== undefined && initialRun.status !== 'running') {
    const result = { run: initialRun, worker: { worker_id: options.workerId, skipped: true, reason: 'run_has_no_candidates' } };
    await writeState(options.statePath, result);
    return result;
  }

  const vlm = createVlm();
  await client.json(`/v1/agent/frame-search/${encodeURIComponent(runId)}/claim`, {
    method: 'POST', body: JSON.stringify({ lease_ms: options.leaseMs }),
  });
  await writeState(options.statePath, { run_id: runId, worker_id: options.workerId, query, status: 'running' });

  let finalStatus: unknown;
  const startedAt = performance.now();
  let batchesProcessed = 0;
  let framesProcessed = 0;
  let clipAutoRejected = 0;
  let clipAutoAccepted = 0;
  let vlmReviewed = 0;
  let pausedByLimit = false;
  try {
    while (true) {
      await client.json(`/v1/agent/frame-search/${encodeURIComponent(runId)}/heartbeat`, {
        method: 'POST', body: JSON.stringify({ lease_ms: options.leaseMs }),
      });
      const response = await client.json<BatchResponse>(
        `/v1/agent/frame-search/${encodeURIComponent(runId)}/batch`,
      );
      if (!response.batch || response.run.status !== 'running') {
        finalStatus = await client.json(`/v1/agent/frame-search/${encodeURIComponent(runId)}`);
        break;
      }
      clipAutoRejected += response.batch.frames.filter((frame) => frame.prefilter_route === 'auto_reject').length;
      clipAutoAccepted += response.batch.frames.filter((frame) => frame.prefilter_route === 'auto_accept').length;
      vlmReviewed += response.batch.frames.filter((frame) => frame.prefilter_route === 'vlm_review').length;
      const judgments = await judgeBatch(response.batch.frames, query!, vlm, options.vlmConcurrency);
      const submitted = await client.json<{ run: RunSummary }>(
        `/v1/agent/frame-search/${encodeURIComponent(runId)}/judgments`, {
        method: 'POST', body: JSON.stringify({ judgments }),
        },
      );
      await writeState(options.statePath, {
        run_id: runId,
        worker_id: options.workerId,
        query,
        status: 'running',
        frames_examined: response.run.frames_examined + judgments.length,
        updated_at: new Date().toISOString(),
      });
      process.stdout.write(
        `[agent-worker] run=${runId} frames=${response.run.frames_examined + judgments.length}/${response.run.frames_total}\n`,
      );
      batchesProcessed += 1;
      framesProcessed += judgments.length;
      if (submitted.run.status !== 'running') {
        finalStatus = await client.json(`/v1/agent/frame-search/${encodeURIComponent(runId)}`);
        break;
      }
      if (options.maxBatches > 0 && batchesProcessed >= options.maxBatches) {
        pausedByLimit = true;
        finalStatus = await client.json(`/v1/agent/frame-search/${encodeURIComponent(runId)}`);
        break;
      }
    }
  } finally {
    await client.json(`/v1/agent/frame-search/${encodeURIComponent(runId)}/release`, { method: 'POST' })
      .catch(() => undefined);
  }
  const finalRun = finalStatus && typeof finalStatus === 'object' && 'run' in finalStatus
    ? (finalStatus as { run?: RunSummary }).run
    : undefined;
  await writeState(options.statePath, {
    run_id: runId,
    worker_id: options.workerId,
    query,
    status: pausedByLimit ? 'paused' : (finalRun?.status ?? 'unknown'),
    metrics: {
      batches_processed: batchesProcessed,
      frames_processed: framesProcessed,
      clip_auto_rejected: clipAutoRejected,
      clip_auto_accepted: clipAutoAccepted,
      vlm_reviewed: vlmReviewed,
      elapsed_ms: Math.round(performance.now() - startedAt),
    },
  });
  return {
    ...(finalStatus && typeof finalStatus === 'object' ? finalStatus : { result: finalStatus }),
    worker: {
      worker_id: options.workerId,
      paused_by_limit: pausedByLimit,
      batches_processed: batchesProcessed,
      frames_processed: framesProcessed,
      clip_auto_rejected: clipAutoRejected,
      clip_auto_accepted: clipAutoAccepted,
      vlm_reviewed: vlmReviewed,
      elapsed_ms: Math.round(performance.now() - startedAt),
    },
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/rest-worker.ts')) {
  runWorker(parseOptions(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`[agent-worker] ${error instanceof Error ? error.message : 'worker failed'}\n`);
      process.exitCode = 1;
    });
}
