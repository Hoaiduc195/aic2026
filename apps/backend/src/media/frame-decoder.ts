import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import type { FfmpegSpawn } from './image-compressor';

export interface FrameDecodeInput {
  readonly video_url: string;
  readonly original_frame_id: number;
  readonly fps: number;
  readonly max_bytes?: number;
}

export interface DecodedFrame {
  readonly mime_type: 'image/jpeg';
  readonly bytes: Buffer;
}

export interface FrameDecoder {
  decode(input: FrameDecodeInput): Promise<DecodedFrame>;
}

const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = MAX_OUTPUT_BYTES;
const PROFILES = [
  { max_dimension: 2048, quality: 5 },
  { max_dimension: 1600, quality: 10 },
  { max_dimension: 1280, quality: 15 },
  { max_dimension: 1024, quality: 20 },
  { max_dimension: 768, quality: 25 },
  { max_dimension: 512, quality: 30 },
  { max_dimension: 384, quality: 31 },
  { max_dimension: 256, quality: 31 },
  { max_dimension: 128, quality: 31 },
] as const;

class OutputTooLargeError extends Error {
  constructor() {
    super('Decoded frame exceeds the output limit');
  }
}

function validateOutputBytes(value: number | undefined): number {
  const maxBytes = value ?? DEFAULT_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_OUTPUT_BYTES) {
    throw new Error(`max_bytes must be a positive integer no larger than ${MAX_OUTPUT_BYTES}`);
  }
  return maxBytes;
}

function decodeAttempt(
  spawnProcess: FfmpegSpawn,
  ffmpegPath: string,
  input: FrameDecodeInput,
  maxBytes: number,
  profile: (typeof PROFILES)[number],
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let child: Pick<ChildProcess, 'stdout' | 'stderr' | 'once' | 'kill'>;
    try {
      child = spawnProcess(ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', input.video_url,
        '-vf', `select=eq(n\\,${input.original_frame_id}),scale=${profile.max_dimension}:${profile.max_dimension}:force_original_aspect_ratio=decrease`,
        '-frames:v', '1',
        '-q:v', String(profile.quality),
        '-pix_fmt', 'yuvj420p',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(error instanceof Error ? error : new Error('FFmpeg frame process could not start'));
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, bytes?: Buffer) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else if (!bytes || bytes.length === 0) reject(new Error(stderr.trim() || 'FFmpeg returned no frame'));
      else resolve(bytes);
    };

    const stdout = child.stdout;
    if (!stdout) {
      finish(new Error('FFmpeg frame output is unavailable'));
      return;
    }
    stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        child.kill('SIGKILL');
        finish(new OutputTooLargeError());
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 4000);
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('FFmpeg frame decode timed out'));
    }, timeoutMs);
    child.once('error', (error) => finish(error instanceof Error ? error : new Error('FFmpeg frame process failed')));
    child.once('close', (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || `FFmpeg exited with code ${code ?? 'unknown'}`));
        return;
      }
      finish(undefined, Buffer.concat(chunks, totalBytes));
    });
  });
}

export class FfmpegFrameDecoder implements FrameDecoder {
  private readonly spawnProcess: FfmpegSpawn;

  constructor(
    private readonly ffmpegPath = 'ffmpeg',
    private readonly timeoutMs = 15_000,
    spawnProcess: FfmpegSpawn = spawn,
  ) {
    this.spawnProcess = spawnProcess;
  }

  async decode(input: FrameDecodeInput): Promise<DecodedFrame> {
    if (!Number.isSafeInteger(input.original_frame_id) || input.original_frame_id < 0) {
      throw new Error('original_frame_id must be a non-negative integer');
    }
    if (!Number.isFinite(input.fps) || input.fps <= 0) {
      throw new Error('fps must be a positive number');
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('FFmpeg frame decode timeout must be a positive integer');
    }
    const maxBytes = validateOutputBytes(input.max_bytes);

    for (const profile of PROFILES) {
      try {
        const bytes = await decodeAttempt(
          this.spawnProcess, this.ffmpegPath, input, maxBytes, profile, this.timeoutMs,
        );
        return { mime_type: 'image/jpeg', bytes };
      } catch (error) {
        if (error instanceof OutputTooLargeError) continue;
        throw error;
      }
    }
    throw new Error('FFmpeg could not decode the frame below the requested limit');
  }
}
