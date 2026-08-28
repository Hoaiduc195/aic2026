import 'dotenv/config';

import { spawn } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { OpenAICompatibleVisionClient, type VlmUsage } from '../compute/vlm-vision.client';

type Task = 'textual_kis' | 'vqa' | 'trake';
type ScanMode = 'sparse' | 'dense' | 'temporal_zoom';
type PrefilterRoute = 'auto_reject' | 'auto_accept' | 'vlm_review';

interface WorkerOptions {
  readonly query?: string;
  readonly runId?: string;
  readonly task: Task;
  readonly topK: number;
  readonly videoBudget: number;
  readonly frameBatchSize: number;
  readonly scanMode: ScanMode;
  readonly workerId: string;
  readonly backendUrl: string;
  readonly operatorToken?: string;
  readonly leaseMs: number;
  readonly vlmConcurrency: number;
  readonly clipBatchSize: number;
  readonly prefilterCandidateRatio: number;
  readonly vlmCandidateRatio: number;
  readonly prefilterIntervalSeconds: number;
  readonly denseFrameSize: number;
  readonly vlmGridSize: number;
  readonly vlmFinalScore: number;
  readonly temporalWindowSeconds: number;
  readonly temporalMergeGapSeconds: number;
  readonly temporalWindowsPerVideo: number;
  readonly temporalSampleFps: number;
  readonly temporalFinalRadiusSeconds: number;
  readonly temporalStopScore: number;
  readonly temporalDeadlineSeconds: number;
  readonly temporalFinalClipCandidates: number;
  readonly storyboardColumns: number;
  readonly maxBatches: number;
  readonly statePath: string;
}

export interface BatchFrame {
  readonly video_id: string;
  readonly original_frame_id: number;
  readonly thumbnail_uri: string;
  readonly frame_source?: 'keyframe' | 'raw_video' | 'temporal_sample';
  readonly timestamp_ms?: number;
  readonly window_id?: number;
  readonly window_start_ms?: number;
  readonly window_end_ms?: number;
  readonly clip_score: number | null;
  readonly prefilter_route: PrefilterRoute;
  readonly prefilter_reason?: string;
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
  readonly scan_mode?: ScanMode;
}

interface BatchResponse {
  readonly run: RunSummary;
  readonly batch: null | {
    readonly frames: readonly BatchFrame[];
    readonly video_uri?: string;
    readonly fps?: number;
  };
}

interface Judgment {
  readonly video_id: string;
  readonly original_frame_id: number;
  readonly relevant: boolean;
  readonly score: number;
  readonly reason: string;
}

interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost: number;
  cost_reported: boolean;
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
  const scanMode = values.get('scan-mode') ?? 'sparse';
  if (scanMode !== 'sparse' && scanMode !== 'dense' && scanMode !== 'temporal_zoom') {
    throw new Error('scan-mode must be sparse, temporal_zoom or dense');
  }
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
    frameBatchSize: integer(values.get('batch-size'), scanMode === 'temporal_zoom' ? 16 : 256, 1, 512),
    scanMode,
    workerId,
    backendUrl: (process.env.BACKEND_URL?.trim() || 'http://localhost:4000').replace(/\/+$/, ''),
    operatorToken: process.env.BACKEND_OPERATOR_TOKEN?.trim() || process.env.OPERATOR_TOKEN?.trim() || undefined,
    leaseMs: integer(process.env.AGENT_WORKER_LEASE_MS, 300_000, 10_000, 300_000),
    vlmConcurrency: integer(process.env.AGENT_WORKER_VLM_CONCURRENCY, 2, 1, 8),
    clipBatchSize: integer(process.env.AGENT_CLIP_BATCH_SIZE, 8, 1, 32),
    prefilterCandidateRatio: decimal(process.env.AGENT_PREFILTER_CANDIDATE_RATIO, 0.05, 0.001, 0.5),
    vlmCandidateRatio: decimal(process.env.AGENT_VLM_CANDIDATE_RATIO, 0.005, 0.0001, 0.2),
    prefilterIntervalSeconds: decimal(process.env.AGENT_PREFILTER_INTERVAL_SECONDS, 1, 0.1, 10),
    denseFrameSize: integer(process.env.AGENT_DENSE_FRAME_SIZE, 448, 112, 1024),
    vlmGridSize: integer(process.env.AGENT_VLM_GRID_SIZE, 8, 2, 16),
    vlmFinalScore: decimal(process.env.AGENT_VLM_FINAL_SCORE, 0.55, 0, 1),
    temporalWindowSeconds: integer(values.get('temporal-window-seconds'), 20, 5, 120),
    temporalMergeGapSeconds: integer(values.get('temporal-merge-gap-seconds'), 15, 0, 120),
    temporalWindowsPerVideo: integer(values.get('temporal-windows-per-video'), 2, 1, 10),
    temporalSampleFps: integer(values.get('temporal-sample-fps'), 1, 1, 5),
    temporalFinalRadiusSeconds: decimal(
      process.env.AGENT_TEMPORAL_FINAL_RADIUS_SECONDS, 2, 0.5, 10,
    ),
    temporalStopScore: decimal(process.env.AGENT_TEMPORAL_STOP_SCORE, 0.82, 0.5, 1),
    temporalDeadlineSeconds: integer(process.env.AGENT_TEMPORAL_DEADLINE_SECONDS, 300, 30, 1800),
    temporalFinalClipCandidates: integer(process.env.AGENT_TEMPORAL_FINAL_CLIP_CANDIDATES, 24, 4, 64),
    storyboardColumns: integer(process.env.AGENT_STORYBOARD_COLUMNS, 4, 2, 4),
    maxBatches: integer(values.get('max-batches'), 0, 0, 100_000),
    statePath,
  };
}

function decimal(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`expected number between ${minimum} and ${maximum}, received ${value ?? fallback}`);
  }
  return parsed;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class NonRetryableHttpError extends Error {}

class RestClient {
  constructor(private readonly options: WorkerOptions) {}

  async json<T>(path: string, init: RequestInit = {}, retries = 4, timeoutMs = 30_000): Promise<T> {
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
          signal: AbortSignal.timeout(timeoutMs),
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
    const detail = lastError instanceof Error ? lastError.message : 'unknown backend error';
    throw new Error(`backend request ${init.method ?? 'GET'} ${path} failed after retries: ${detail}`);
  }

  async imageDataUri(pathOrUrl: string): Promise<string> {
    if (!pathOrUrl.startsWith('/')) return pathOrUrl;
    const response = await fetch(`${this.options.backendUrl}${pathOrUrl}`, {
      headers: {
        'x-agent-worker-id': this.options.workerId,
        ...(this.options.operatorToken ? { 'x-operator-token': this.options.operatorToken } : {}),
      },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`frame image HTTP ${response.status}: ${pathOrUrl}`);
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (!mimeType?.startsWith('image/')) throw new Error(`frame image has invalid content-type: ${mimeType ?? 'missing'}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) {
      throw new Error(`frame image has invalid size: ${bytes.length}`);
    }
    return `data:${mimeType};base64,${bytes.toString('base64')}`;
  }
}

class LocalClipPrefilter {
  private readonly textEndpoint: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor() {
    const endpoint = process.env.AGENT_PREFILTER_SERVICE_URL?.trim()
      || process.env.EMBEDDING_SERVICE_URL?.trim();
    if (!endpoint) throw new Error('AGENT_PREFILTER_SERVICE_URL or EMBEDDING_SERVICE_URL is required for dense CLIP prefilter');
    const normalized = endpoint.replace(/\/+$/, '');
    this.textEndpoint = normalized.endsWith('/embed') ? normalized : `${normalized}/embed`;
    this.token = process.env.EMBEDDING_SERVICE_TOKEN?.trim() || undefined;
    this.timeoutMs = integer(process.env.EMBEDDING_SERVICE_TIMEOUT_MS, 30_000, 1_000, 120_000);
  }

  embedText(text: string): Promise<readonly number[]> {
    return this.requestOne(this.textEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ text }),
    });
  }

  async embedImages(dataUris: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (dataUris.length === 0) return [];
    const images = dataUris.map((dataUri) => {
      const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUri);
      if (!match) throw new Error('dense prefilter received an invalid image data URL');
      return { mime_type: match[1], data_base64: match[2] };
    });
    const response = await fetch(`${this.textEndpoint}/images`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ images }),
      signal: AbortSignal.timeout(this.timeoutMs * Math.max(1, dataUris.length)),
    });
    if (!response.ok) throw new Error(`local batch embedding service returned HTTP ${response.status}`);
    const payload = await response.json() as { embeddings?: unknown };
    if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== dataUris.length) {
      throw new Error('local batch embedding service returned an invalid batch');
    }
    return payload.embeddings.map((embedding) => {
      if (!Array.isArray(embedding) || embedding.length === 0
        || embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('local batch embedding service returned an invalid vector');
      }
      return embedding as number[];
    });
  }

  private async requestOne(endpoint: string, init: RequestInit): Promise<readonly number[]> {
    const response = await fetch(endpoint, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`local embedding service returned HTTP ${response.status}`);
    const payload = await response.json() as { embedding?: unknown };
    if (!Array.isArray(payload.embedding) || payload.embedding.length === 0
      || payload.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('local embedding service returned an invalid vector');
    }
    return payload.embedding as number[];
  }
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) throw new Error('CLIP vectors have incompatible dimensions');
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) throw new Error('CLIP vector norm is zero');
  return dot / Math.sqrt(leftNorm * rightNorm);
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

interface CheapScanCandidate {
  readonly frame: BatchFrame;
  readonly raw: Buffer;
  readonly priority: number;
  readonly difference: number;
}

interface CheapScanState {
  videoId?: string;
  previousSignature?: Uint8Array;
}

class DenseVideoStream {
  readonly videoId: string;
  private readonly child: ReturnType<typeof spawn>;
  private readonly iterator: AsyncIterator<Buffer | Uint8Array>;
  private buffered = Buffer.alloc(0);
  private nextFrameId: number;
  private readonly bytesPerFrame: number;
  private failure?: Error;

  constructor(videoId: string, videoUrl: string, fps: number, startFrameId: number, size: number) {
    if (!videoUrl || !Number.isFinite(fps) || fps <= 0) throw new Error('dense stream is missing video URL or fps');
    this.videoId = videoId;
    this.nextFrameId = startFrameId;
    this.bytesPerFrame = size * size * 3;
    const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
    const seek = startFrameId > 0 ? ['-ss', (startFrameId / fps).toFixed(9)] : [];
    this.child = spawn(ffmpegPath, [
      '-loglevel', 'error', ...seek, '-i', videoUrl,
      '-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:black`,
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr?.resume(); // Never print stderr because it can contain the signed R2 URL.
    this.child.on('error', () => { this.failure = new Error('dense FFmpeg process could not start'); });
    this.iterator = this.child.stdout![Symbol.asyncIterator]() as AsyncIterator<Buffer | Uint8Array>;
  }

  canContinue(videoId: string, firstFrameId: number): boolean {
    return this.videoId === videoId && this.nextFrameId === firstFrameId;
  }

  async readFrame(expectedFrameId: number): Promise<Buffer> {
    if (expectedFrameId !== this.nextFrameId) throw new Error('dense stream frame cursor is not contiguous');
    while (this.buffered.length < this.bytesPerFrame) {
      const next = await this.iterator.next();
      if (next.done) throw this.failure ?? new Error(`dense FFmpeg stream ended before frame ${expectedFrameId}`);
      this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
    }
    const frame = Buffer.from(this.buffered.subarray(0, this.bytesPerFrame));
    this.buffered = this.buffered.subarray(this.bytesPerFrame);
    this.nextFrameId += 1;
    return frame;
  }

  close(): void {
    if (!this.child.killed) this.child.kill('SIGKILL');
  }
}

class DenseVideoStreamManager {
  private stream?: DenseVideoStream;

  get(videoId: string, videoUrl: string, fps: number, firstFrameId: number, size: number): DenseVideoStream {
    if (!this.stream?.canContinue(videoId, firstFrameId)) {
      this.stream?.close();
      this.stream = new DenseVideoStream(videoId, videoUrl, fps, firstFrameId, size);
    }
    return this.stream;
  }

  close(): void {
    this.stream?.close();
    this.stream = undefined;
  }
}

export function frameSignature(raw: Buffer, size: number): Uint8Array {
  const cells = 16;
  const result = new Uint8Array(cells * cells);
  for (let y = 0; y < cells; y += 1) {
    const sourceY = Math.min(size - 1, Math.floor(((y + 0.5) * size) / cells));
    for (let x = 0; x < cells; x += 1) {
      const sourceX = Math.min(size - 1, Math.floor(((x + 0.5) * size) / cells));
      const offset = (sourceY * size + sourceX) * 3;
      result[y * cells + x] = Math.round(raw[offset] * 0.299 + raw[offset + 1] * 0.587 + raw[offset + 2] * 0.114);
    }
  }
  return result;
}

export function signatureDifference(left: Uint8Array | undefined, right: Uint8Array): number {
  if (!left || left.length !== right.length) return 1;
  let total = 0;
  for (let index = 0; index < right.length; index += 1) total += Math.abs(left[index] - right[index]);
  return total / (right.length * 255);
}

async function scanDenseBatch(
  frames: readonly BatchFrame[],
  stream: DenseVideoStream,
  fps: number,
  options: WorkerOptions,
  state: CheapScanState,
): Promise<CheapScanCandidate[]> {
  if (state.videoId !== frames[0]?.video_id) state.previousSignature = undefined;
  const budget = Math.max(2, Math.ceil(frames.length * options.prefilterCandidateRatio));
  const intervalFrames = Math.max(1, Math.round(fps * options.prefilterIntervalSeconds));
  const best: CheapScanCandidate[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const raw = await stream.readFrame(frame.original_frame_id);
    const signature = frameSignature(raw, options.denseFrameSize);
    const difference = signatureDifference(state.previousSignature, signature);
    state.previousSignature = signature;
    state.videoId = frame.video_id;
    const periodic = frame.original_frame_id % intervalFrames === 0;
    const boundary = index === 0 || index === frames.length - 1;
    // Periodic samples protect static scenes, while a strong visual change can
    // still outrank a low-motion periodic frame inside the bounded budget.
    const priority = difference + (periodic ? 0.25 : 0) + (boundary ? 0.15 : 0);
    const candidate = { frame, raw, priority, difference };
    if (best.length < budget) best.push(candidate);
    else {
      let minimumIndex = 0;
      for (let candidateIndex = 1; candidateIndex < best.length; candidateIndex += 1) {
        if (best[candidateIndex].priority < best[minimumIndex].priority) minimumIndex = candidateIndex;
      }
      if (priority > best[minimumIndex].priority) best[minimumIndex] = candidate;
    }
  }
  return best.sort((left, right) => left.frame.original_frame_id - right.frame.original_frame_id);
}

function splitJpegs(bytes: Buffer, expected: number): Buffer[] {
  const images: Buffer[] = [];
  let cursor = 0;
  while (images.length < expected) {
    const start = bytes.indexOf(Buffer.from([0xff, 0xd8]), cursor);
    if (start < 0) break;
    const end = bytes.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) break;
    images.push(bytes.subarray(start, end + 2));
    cursor = end + 2;
  }
  if (images.length !== expected) throw new Error(`dense JPEG encoder returned ${images.length}/${expected} images`);
  return images;
}

async function encodeRawFrames(candidates: readonly CheapScanCandidate[], size: number): Promise<Map<number, string>> {
  if (candidates.length === 0) return new Map();
  const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  const child = spawn(ffmpegPath, [
    '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${size}x${size}`, '-r', '1', '-i', 'pipe:0',
    '-frames:v', String(candidates.length), '-q:v', '8', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr?.resume();
  const output: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)));
  for (const candidate of candidates) child.stdin?.write(candidate.raw);
  child.stdin?.end();
  await new Promise<void>((resolveProcess, rejectProcess) => {
    child.once('error', () => rejectProcess(new Error('dense JPEG encoder could not start')));
    child.once('close', (code) => code === 0
      ? resolveProcess()
      : rejectProcess(new Error(`dense JPEG encoder exited with code ${code ?? 'unknown'}`)));
  });
  const jpegs = splitJpegs(Buffer.concat(output), candidates.length);
  return new Map(candidates.map((candidate, index) => [
    candidate.frame.original_frame_id,
    `data:image/jpeg;base64,${jpegs[index].toString('base64')}`,
  ]));
}

async function ffmpegRawFrames(args: readonly string[], expected: number, size: number, label: string): Promise<Buffer[]> {
  if (expected === 0) return [];
  const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  const child = spawn(ffmpegPath, [...args, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stderr?.resume();
  const chunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  await new Promise<void>((resolveProcess, rejectProcess) => {
    child.once('error', () => rejectProcess(new Error(`${label} FFmpeg process could not start`)));
    child.once('close', (code) => code === 0
      ? resolveProcess()
      : rejectProcess(new Error(`${label} FFmpeg exited with code ${code ?? 'unknown'}`)));
  });
  const bytes = Buffer.concat(chunks);
  const bytesPerFrame = size * size * 3;
  if (bytes.length < expected * bytesPerFrame) {
    throw new Error(`${label} decoded ${Math.floor(bytes.length / bytesPerFrame)}/${expected} frames`);
  }
  return Array.from({ length: expected }, (_, index) => Buffer.from(
    bytes.subarray(index * bytesPerFrame, (index + 1) * bytesPerFrame),
  ));
}

async function decodeTemporalSamples(
  frames: readonly BatchFrame[],
  videoUrl: string,
  sampleFps: number,
  size: number,
): Promise<CheapScanCandidate[]> {
  if (frames.length === 0) return [];
  const startSeconds = Math.max(0, Number(frames[0].timestamp_ms ?? 0) / 1000);
  const rawFrames = await ffmpegRawFrames([
    '-loglevel', 'error', '-ss', startSeconds.toFixed(6), '-i', videoUrl,
    '-vf', `fps=${sampleFps},scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:black`,
    '-frames:v', String(frames.length),
  ], frames.length, size, 'temporal sample');
  return frames.map((frame, index) => ({ frame, raw: rawFrames[index], priority: 1, difference: 1 }));
}

export function storyboardLayout(frameCount: number, preferredColumns = 4): { columns: number; rows: number } {
  const columns = Math.max(1, Math.min(preferredColumns, frameCount));
  return { columns, rows: Math.ceil(frameCount / columns) };
}

async function createStoryboardDataUri(
  candidates: readonly CheapScanCandidate[],
  size: number,
  preferredColumns: number,
): Promise<{ dataUri: string; columns: number }> {
  if (candidates.length === 0) throw new Error('cannot create an empty storyboard');
  const { columns, rows } = storyboardLayout(candidates.length, preferredColumns);
  const tileSize = 224;
  const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  const child = spawn(ffmpegPath, [
    '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${size}x${size}`,
    '-r', '1', '-i', 'pipe:0',
    '-vf', `scale=${tileSize}:${tileSize},tile=${columns}x${rows}:nb_frames=${candidates.length}:padding=2:margin=2`,
    '-frames:v', '1', '-q:v', '8', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr?.resume();
  const output: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)));
  for (const candidate of candidates) child.stdin?.write(candidate.raw);
  child.stdin?.end();
  await new Promise<void>((resolveProcess, rejectProcess) => {
    child.once('error', () => rejectProcess(new Error('storyboard FFmpeg process could not start')));
    child.once('close', (code) => code === 0
      ? resolveProcess()
      : rejectProcess(new Error(`storyboard FFmpeg exited with code ${code ?? 'unknown'}`)));
  });
  const jpeg = Buffer.concat(output);
  if (jpeg.length === 0) throw new Error('storyboard encoder returned an empty image');
  return { dataUri: `data:image/jpeg;base64,${jpeg.toString('base64')}`, columns };
}

async function decodeFinalWindow(
  frame: BatchFrame,
  videoUrl: string,
  fps: number,
  radiusSeconds: number,
  size: number,
): Promise<CheapScanCandidate[]> {
  const radiusFrames = Math.max(1, Math.round(radiusSeconds * fps));
  const start = Math.max(0, frame.original_frame_id - radiusFrames);
  const end = frame.original_frame_id + radiusFrames;
  const stream = new DenseVideoStream(frame.video_id, videoUrl, fps, start, size);
  const candidates: CheapScanCandidate[] = [];
  try {
    for (let frameId = start; frameId <= end; frameId += 1) {
      const raw = await stream.readFrame(frameId);
      candidates.push({
        frame: {
          video_id: frame.video_id,
          original_frame_id: frameId,
          timestamp_ms: Math.round((frameId / fps) * 1000),
          thumbnail_uri: `/v1/videos/${encodeURIComponent(frame.video_id)}/frames/${frameId}/thumbnail`,
          frame_source: 'raw_video', clip_score: null, prefilter_route: 'vlm_review',
        },
        raw, priority: 1, difference: 1,
      });
    }
  } finally {
    stream.close();
  }
  return candidates;
}

function selectFinalClipCandidates(
  candidates: readonly CheapScanCandidate[],
  fps: number,
  limit: number,
): CheapScanCandidate[] {
  if (candidates.length <= limit) return [...candidates];
  const periodicStep = Math.max(1, Math.round(fps / 4));
  let previous: Uint8Array | undefined;
  const scored = candidates.map((candidate, index) => {
    const signature = frameSignature(candidate.raw, Math.round(Math.sqrt(candidate.raw.length / 3)));
    const difference = signatureDifference(previous, signature);
    previous = signature;
    const periodic = index % periodicStep === 0;
    const boundary = index === 0 || index === candidates.length - 1;
    return { ...candidate, difference, priority: difference + (periodic ? 0.3 : 0) + (boundary ? 0.2 : 0) };
  });
  return scored
    .sort((left, right) => right.priority - left.priority)
    .slice(0, limit)
    .sort((left, right) => left.frame.original_frame_id - right.frame.original_frame_id);
}

async function embedCandidateImages(
  candidates: readonly CheapScanCandidate[],
  images: ReadonlyMap<number, string>,
  clip: LocalClipPrefilter,
  batchSize: number,
): Promise<Map<number, readonly number[]>> {
  const result = new Map<number, readonly number[]>();
  for (let start = 0; start < candidates.length; start += batchSize) {
    const chunk = candidates.slice(start, start + batchSize);
    const vectors = await clip.embedImages(chunk.map((candidate) => images.get(candidate.frame.original_frame_id)!));
    chunk.forEach((candidate, index) => result.set(candidate.frame.original_frame_id, vectors[index]));
  }
  return result;
}

async function routeDenseCascade(
  frames: readonly BatchFrame[],
  stream: DenseVideoStream,
  fps: number,
  queryEmbedding: readonly number[],
  clip: LocalClipPrefilter,
  options: WorkerOptions,
  state: CheapScanState,
): Promise<{ frames: BatchFrame[]; images: Map<number, string>; clipCandidates: number }> {
  const candidates = await scanDenseBatch(frames, stream, fps, options, state);
  const images = await encodeRawFrames(candidates, options.denseFrameSize);
  const embeddings = await embedCandidateImages(candidates, images, clip, options.clipBatchSize);
  const scored = candidates.map((candidate) => ({
    candidate,
    score: cosineSimilarity(queryEmbedding, embeddings.get(candidate.frame.original_frame_id)!),
  })).sort((left, right) => right.score - left.score);
  const vlmBudget = Math.max(1, Math.ceil(frames.length * options.vlmCandidateRatio));
  const vlmIds = new Set(scored.slice(0, Math.min(vlmBudget, scored.length))
    .map((item) => item.candidate.frame.original_frame_id));
  const scoreById = new Map(scored.map((item) => [item.candidate.frame.original_frame_id, item.score]));
  const candidateIds = new Set(candidates.map((candidate) => candidate.frame.original_frame_id));
  return {
    frames: frames.map((frame) => {
      const score = scoreById.get(frame.original_frame_id) ?? null;
      if (vlmIds.has(frame.original_frame_id)) {
        return { ...frame, clip_score: score, prefilter_route: 'vlm_review', prefilter_reason: 'clip_top_candidate' };
      }
      return {
        ...frame,
        clip_score: score,
        prefilter_route: 'auto_reject',
        prefilter_reason: candidateIds.has(frame.original_frame_id) ? 'clip_pruned' : 'cheap_prefilter_pruned',
      };
    }),
    images: new Map([...images].filter(([frameId]) => vlmIds.has(frameId))),
    clipCandidates: candidates.length,
  };
}

function createVlm(): OpenAICompatibleVisionClient {
  const agentBaseUrl = process.env.AGENT_WORKER_VLM_BASE_URL?.trim();
  const baseUrl = agentBaseUrl
    || process.env.VLM_BASE_URL?.trim()
    || process.env.LLM_BASE_URL?.trim();
  const model = process.env.AGENT_WORKER_VLM_MODEL?.trim()
    || process.env.VLM_MODEL?.trim()
    || process.env.LLM_MODEL?.trim();
  if (!baseUrl || !model) throw new Error('VLM_BASE_URL and VLM_MODEL are required for agent worker');
  return new OpenAICompatibleVisionClient({
    baseUrl,
    model,
    apiKey: process.env.AGENT_WORKER_VLM_API_KEY?.trim()
      || process.env.OPENAI_API_KEY?.trim()
      || (!agentBaseUrl
        ? (process.env.VLM_API_KEY?.trim() || process.env.LLM_API_KEY?.trim())
        : undefined)
      || undefined,
    timeoutMs: integer(
      process.env.AGENT_WORKER_VLM_TIMEOUT_MS ?? process.env.VLM_TIMEOUT_MS,
      45_000,
      1_000,
      120_000,
    ),
    maxTokens: integer(process.env.AGENT_WORKER_VLM_MAX_TOKENS ?? process.env.LLM_MAX_TOKENS, 128, 16, 4096),
    temperature: 0,
    retries: 2,
    reasoningEffort: reasoningEffort(process.env.AGENT_WORKER_REASONING_EFFORT),
    imageDetail: imageDetail(process.env.AGENT_WORKER_IMAGE_DETAIL),
  });
}

function reasoningEffort(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(normalized)) {
    throw new Error('AGENT_WORKER_REASONING_EFFORT must be none, low, medium, high, xhigh or max');
  }
  return normalized as 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

function imageDetail(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!['low', 'high', 'auto'].includes(normalized)) {
    throw new Error('AGENT_WORKER_IMAGE_DETAIL must be low, high or auto');
  }
  return normalized as 'low' | 'high' | 'auto';
}

export async function judgeBatch(
  frames: readonly BatchFrame[],
  query: string,
  vlm: Pick<OpenAICompatibleVisionClient, 'verifyImageRelevance'>,
  concurrency: number,
  resolveImageUrl: (frame: BatchFrame) => Promise<string> = async (frame) => frame.thumbnail_uri,
): Promise<Judgment[]> {
  return mapConcurrent(frames, concurrency, async (frame) => {
    if (frame.prefilter_route === 'auto_reject') {
      return {
        video_id: frame.video_id,
        original_frame_id: frame.original_frame_id,
        relevant: false,
        score: Math.max(0, Math.min(1, frame.clip_score ?? 0)),
        reason: `${frame.prefilter_reason ?? 'clip_auto_reject'}:${frame.clip_score ?? 'missing'}`.slice(0, 200),
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
    const imageUrl = await resolveImageUrl(frame);
    const judged = await vlm.verifyImageRelevance({ query, imageUrl });
    return {
      video_id: frame.video_id,
      original_frame_id: frame.original_frame_id,
      relevant: judged.match,
      score: judged.score / 100,
      reason: `vlm:${judged.reason}`.slice(0, 200),
    };
  });
}

function addUsage(total: UsageTotals, usage: VlmUsage | undefined): void {
  if (!usage) return;
  total.input_tokens += usage.input_tokens;
  total.output_tokens += usage.output_tokens;
  total.total_tokens += usage.total_tokens;
  if (usage.cost !== undefined) {
    total.cost += usage.cost;
    total.cost_reported = true;
  }
}

async function judgeDenseCascadeBatch(
  frames: readonly BatchFrame[],
  images: ReadonlyMap<number, string>,
  query: string,
  vlm: OpenAICompatibleVisionClient,
  gridSize: number,
  finalScore: number,
  finalConcurrency: number,
  usage: UsageTotals,
): Promise<{ judgments: Judgment[]; gridCalls: number; finalCalls: number }> {
  const judgments = new Map<number, Judgment>();
  const reviews = frames.filter((frame) => frame.prefilter_route === 'vlm_review');
  for (const frame of frames) {
    if (frame.prefilter_route !== 'vlm_review') {
      judgments.set(frame.original_frame_id, {
        video_id: frame.video_id,
        original_frame_id: frame.original_frame_id,
        relevant: frame.prefilter_route === 'auto_accept',
        score: Math.max(0, Math.min(1, frame.clip_score ?? 0)),
        reason: `${frame.prefilter_reason ?? frame.prefilter_route}:${frame.clip_score ?? 'missing'}`.slice(0, 200),
      });
    }
  }
  let gridCalls = 0;
  let finalCalls = 0;
  for (let start = 0; start < reviews.length; start += gridSize) {
    const grid = reviews.slice(start, start + gridSize);
    const coarse = await vlm.verifyImageBatchRelevance({
      query,
      images: grid.map((frame) => ({
        id: frame.original_frame_id,
        imageUrl: images.get(frame.original_frame_id)!,
      })),
    });
    gridCalls += 1;
    addUsage(usage, coarse.usage);
    const ranked = [...coarse.frames].sort((left, right) => right.score - left.score);
    const refineIds = new Set(ranked
      .filter((item, index) => index === 0 || item.match || item.score / 100 >= finalScore)
      .map((item) => item.id));
    for (const item of coarse.frames) {
      const frame = grid.find((candidate) => candidate.original_frame_id === item.id)!;
      judgments.set(item.id, {
        video_id: frame.video_id,
        original_frame_id: item.id,
        relevant: item.match,
        score: item.score / 100,
        reason: `vlm_grid:${item.reason}`.slice(0, 200),
      });
    }
    const refined = await mapConcurrent(
      grid.filter((frame) => refineIds.has(frame.original_frame_id)),
      finalConcurrency,
      async (frame) => {
        const result = await vlm.verifyImageRelevance({ query, imageUrl: images.get(frame.original_frame_id)! });
        addUsage(usage, result.usage);
        return { frame, result };
      },
    );
    finalCalls += refined.length;
    for (const { frame, result } of refined) {
      judgments.set(frame.original_frame_id, {
        video_id: frame.video_id,
        original_frame_id: frame.original_frame_id,
        relevant: result.match,
        score: result.score / 100,
        reason: `vlm_final:${result.reason}`.slice(0, 200),
      });
    }
  }
  return {
    judgments: frames.map((frame) => judgments.get(frame.original_frame_id)!),
    gridCalls,
    finalCalls,
  };
}

async function judgeTemporalZoomBatch(
  frames: readonly BatchFrame[],
  videoUrl: string,
  fps: number,
  query: string,
  queryEmbedding: readonly number[],
  clip: LocalClipPrefilter,
  vlm: OpenAICompatibleVisionClient,
  options: WorkerOptions,
  usage: UsageTotals,
): Promise<{ judgments: Judgment[]; storyboardCalls: number; finalCalls: number; bestScore: number }> {
  const coarseCandidates = await decodeTemporalSamples(
    frames, videoUrl, options.temporalSampleFps, options.denseFrameSize,
  );
  const coarseStoryboard = await createStoryboardDataUri(
    coarseCandidates, options.denseFrameSize, options.storyboardColumns,
  );
  const coarse = await vlm.verifyStoryboardRelevance({
    query,
    storyboardUrl: coarseStoryboard.dataUri,
    frameIds: frames.map((frame) => frame.original_frame_id),
    columns: coarseStoryboard.columns,
  });
  addUsage(usage, coarse.usage);
  const judgments = new Map<number, Judgment>();
  for (const item of coarse.frames) {
    const frame = frames.find((candidate) => candidate.original_frame_id === item.id)!;
    judgments.set(item.id, {
      video_id: frame.video_id,
      original_frame_id: item.id,
      // A low-resolution storyboard is only a routing signal. It must never be
      // exposed as a final match until the selected raw frame is verified alone.
      relevant: false,
      score: item.score / 100,
      reason: `temporal_storyboard_candidate:${item.reason}`.slice(0, 200),
    });
  }
  const bestCoarse = [...coarse.frames].sort((left, right) => right.score - left.score)[0];
  if (!bestCoarse || bestCoarse.score / 100 < options.vlmFinalScore) {
    return {
      judgments: [...judgments.values()], storyboardCalls: 1, finalCalls: 0,
      bestScore: bestCoarse?.score ? bestCoarse.score / 100 : 0,
    };
  }
  const center = frames.find((frame) => frame.original_frame_id === bestCoarse.id)!;
  let denseCandidates: CheapScanCandidate[];
  try {
    denseCandidates = await decodeFinalWindow(
      center, videoUrl, fps, options.temporalFinalRadiusSeconds, options.denseFrameSize,
    );
  } catch {
    return {
      judgments: [...judgments.values()], storyboardCalls: 1, finalCalls: 0,
      bestScore: bestCoarse.score / 100,
    };
  }
  const clipCandidates = selectFinalClipCandidates(
    denseCandidates, fps, options.temporalFinalClipCandidates,
  );
  const denseImages = await encodeRawFrames(clipCandidates, options.denseFrameSize);
  const embeddings = await embedCandidateImages(clipCandidates, denseImages, clip, options.clipBatchSize);
  const shortlist = clipCandidates
    .map((candidate) => ({
      candidate,
      score: cosineSimilarity(queryEmbedding, embeddings.get(candidate.frame.original_frame_id)!),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.min(options.vlmGridSize, clipCandidates.length))
    .sort((left, right) => left.candidate.frame.original_frame_id - right.candidate.frame.original_frame_id);
  const finalStoryboard = await createStoryboardDataUri(
    shortlist.map((item) => item.candidate), options.denseFrameSize, Math.min(3, options.storyboardColumns),
  );
  const refined = await vlm.verifyStoryboardRelevance({
    query,
    storyboardUrl: finalStoryboard.dataUri,
    frameIds: shortlist.map((item) => item.candidate.frame.original_frame_id),
    columns: finalStoryboard.columns,
  });
  addUsage(usage, refined.usage);
  for (const item of refined.frames) {
    judgments.set(item.id, {
      video_id: center.video_id,
      original_frame_id: item.id,
      relevant: false,
      score: item.score / 100,
      reason: `temporal_zoom_candidate:${item.reason}`.slice(0, 200),
    });
  }
  const bestRefined = [...refined.frames].sort((left, right) => right.score - left.score)[0];
  let finalCalls = 0;
  let finalVerificationScore: number | undefined;
  if (bestRefined) {
    const verified = await vlm.verifyImageRelevance({
      query, imageUrl: denseImages.get(bestRefined.id)!,
    });
    addUsage(usage, verified.usage);
    finalCalls = 1;
    finalVerificationScore = verified.score / 100;
    judgments.set(bestRefined.id, {
      video_id: center.video_id,
      original_frame_id: bestRefined.id,
      relevant: verified.match && verified.score >= 65,
      score: verified.score / 100,
      reason: `temporal_final:${verified.reason}`.slice(0, 200),
    });
  }
  return {
    judgments: [...judgments.values()],
    storyboardCalls: 2,
    finalCalls,
    bestScore: finalVerificationScore
      ?? (bestRefined?.score ? bestRefined.score / 100 : bestCoarse.score / 100),
  };
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
        scan_mode: options.scanMode,
        temporal_window_seconds: options.temporalWindowSeconds,
        temporal_merge_gap_seconds: options.temporalMergeGapSeconds,
        temporal_windows_per_video: options.temporalWindowsPerVideo,
        temporal_sample_fps: options.temporalSampleFps,
      }),
    // Creating a run performs coarse retrieval and may probe video metadata.
    // Do not retry this non-idempotent POST: a timeout retry could create two runs.
    }, 0, 120_000);
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
  const effectiveScanMode = initialRun?.scan_mode ?? options.scanMode;

  const vlm = createVlm();
  let clipPrefilter: LocalClipPrefilter | undefined;
  let clipQueryEmbedding: readonly number[] | undefined;
  const denseStreams = new DenseVideoStreamManager();
  const cheapScanState: CheapScanState = {};
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
  let clipCandidates = 0;
  let vlmGridCalls = 0;
  let vlmFinalCalls = 0;
  let temporalStoryboardCalls = 0;
  let temporalBestScore = 0;
  const tokenUsage: UsageTotals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost: 0, cost_reported: false };
  let pausedByLimit = false;
  try {
    while (true) {
      if (effectiveScanMode === 'temporal_zoom'
        && performance.now() - startedAt >= options.temporalDeadlineSeconds * 1000) {
        finalStatus = await client.json(
          `/v1/agent/frame-search/${encodeURIComponent(runId)}/complete`, { method: 'POST' },
        );
        break;
      }
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
      const denseFrames = response.batch.frames.filter((frame) => frame.frame_source === 'raw_video');
      const temporalFrames = response.batch.frames.filter((frame) => frame.frame_source === 'temporal_sample');
      let denseImages = new Map<number, string>();
      let framesForJudgment = [...response.batch.frames];
      if (denseFrames.length > 0) {
        clipPrefilter ??= new LocalClipPrefilter();
        clipQueryEmbedding ??= await clipPrefilter.embedText(query!);
        const stream = denseStreams.get(
          denseFrames[0].video_id,
          response.batch.video_uri ?? '',
          Number(response.batch.fps),
          denseFrames[0].original_frame_id,
          options.denseFrameSize,
        );
        const cascade = await routeDenseCascade(
          denseFrames, stream, Number(response.batch.fps), clipQueryEmbedding, clipPrefilter, options, cheapScanState,
        );
        denseImages = cascade.images;
        clipCandidates += cascade.clipCandidates;
        const routedById = new Map(cascade.frames.map((frame) => [frame.original_frame_id, frame]));
        framesForJudgment = framesForJudgment.map((frame) => routedById.get(frame.original_frame_id) ?? frame);
      }
      clipAutoRejected += framesForJudgment.filter((frame) => frame.prefilter_route === 'auto_reject').length;
      clipAutoAccepted += framesForJudgment.filter((frame) => frame.prefilter_route === 'auto_accept').length;
      vlmReviewed += framesForJudgment.filter((frame) => frame.prefilter_route === 'vlm_review').length;
      let judgments: Judgment[];
      let batchBestScore = 0;
      if (temporalFrames.length > 0) {
        clipPrefilter ??= new LocalClipPrefilter();
        clipQueryEmbedding ??= await clipPrefilter.embedText(query!);
        const temporalResult = await judgeTemporalZoomBatch(
          temporalFrames,
          response.batch.video_uri ?? '',
          Number(response.batch.fps),
          query!,
          clipQueryEmbedding,
          clipPrefilter,
          vlm,
          options,
          tokenUsage,
        );
        judgments = temporalResult.judgments;
        temporalStoryboardCalls += temporalResult.storyboardCalls;
        vlmFinalCalls += temporalResult.finalCalls;
        batchBestScore = temporalResult.bestScore;
        temporalBestScore = Math.max(temporalBestScore, batchBestScore);
      } else if (denseFrames.length > 0) {
        const denseResult = await judgeDenseCascadeBatch(
          framesForJudgment, denseImages, query!, vlm, options.vlmGridSize,
          options.vlmFinalScore, options.vlmConcurrency, tokenUsage,
        );
        judgments = denseResult.judgments;
        vlmGridCalls += denseResult.gridCalls;
        vlmFinalCalls += denseResult.finalCalls;
      } else {
        judgments = await judgeBatch(
          framesForJudgment, query!, vlm, options.vlmConcurrency,
          (frame) => client.imageDataUri(frame.thumbnail_uri),
        );
      }
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
        frames_examined: response.run.frames_examined + response.batch.frames.length,
        updated_at: new Date().toISOString(),
      });
      process.stdout.write(
        `[agent-worker] run=${runId} frames=${response.run.frames_examined + response.batch.frames.length}/${response.run.frames_total}\n`,
      );
      batchesProcessed += 1;
      framesProcessed += response.batch.frames.length;
      if (temporalFrames.length > 0 && batchBestScore >= options.temporalStopScore) {
        finalStatus = await client.json(
          `/v1/agent/frame-search/${encodeURIComponent(runId)}/complete`, { method: 'POST' },
        );
        break;
      }
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
  } catch (error) {
    await writeState(options.statePath, {
      run_id: runId,
      worker_id: options.workerId,
      query,
      status: 'paused_error',
      error: error instanceof Error ? error.message.slice(0, 300) : 'worker failed',
      metrics: {
        batches_processed: batchesProcessed,
        frames_processed: framesProcessed,
        clip_candidates: clipCandidates,
        vlm_reviewed: vlmReviewed,
        vlm_grid_calls: vlmGridCalls,
        vlm_final_calls: vlmFinalCalls,
        temporal_storyboard_calls: temporalStoryboardCalls,
        temporal_best_score: temporalBestScore,
        elapsed_ms: Math.round(performance.now() - startedAt),
      },
    });
    throw error;
  } finally {
    denseStreams.close();
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
      clip_candidates: clipCandidates,
      vlm_reviewed: vlmReviewed,
      vlm_grid_calls: vlmGridCalls,
      vlm_final_calls: vlmFinalCalls,
      temporal_storyboard_calls: temporalStoryboardCalls,
      temporal_best_score: temporalBestScore,
      vlm_usage: {
        input_tokens: tokenUsage.input_tokens,
        output_tokens: tokenUsage.output_tokens,
        total_tokens: tokenUsage.total_tokens,
        ...(tokenUsage.cost_reported ? { cost: tokenUsage.cost } : {}),
      },
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
      clip_candidates: clipCandidates,
      vlm_reviewed: vlmReviewed,
      vlm_grid_calls: vlmGridCalls,
      vlm_final_calls: vlmFinalCalls,
      temporal_storyboard_calls: temporalStoryboardCalls,
      temporal_best_score: temporalBestScore,
      vlm_usage: {
        input_tokens: tokenUsage.input_tokens,
        output_tokens: tokenUsage.output_tokens,
        total_tokens: tokenUsage.total_tokens,
        ...(tokenUsage.cost_reported ? { cost: tokenUsage.cost } : {}),
      },
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
