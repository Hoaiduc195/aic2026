import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface ImageCompressionInput {
  readonly image_url: string;
  readonly target_bytes?: number;
}

export interface CompressedImage {
  readonly mime_type: 'image/jpeg';
  readonly bytes: Buffer;
}

export interface ImageCompressor {
  compress(input: ImageCompressionInput): Promise<CompressedImage>;
}

export type FfmpegSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => Pick<ChildProcess, 'stdout' | 'stderr' | 'once' | 'kill'>;

const MAX_TARGET_BYTES = 12 * 1024 * 1024;
const DEFAULT_TARGET_BYTES = 8 * 1024 * 1024;
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
    super('FFmpeg image output exceeds the requested limit');
  }
}

function validateImageUrl(value: string): string {
  const normalized = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('image URL must be absolute');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('image URL must use HTTP(S)');
  }
  return normalized;
}

function validateTargetBytes(value: number | undefined): number {
  const target = value ?? DEFAULT_TARGET_BYTES;
  if (!Number.isSafeInteger(target) || target <= 0 || target > MAX_TARGET_BYTES) {
    throw new Error(`image target_bytes must be a positive integer no larger than ${MAX_TARGET_BYTES}`);
  }
  return target;
}

function runAttempt(
  spawnProcess: FfmpegSpawn,
  ffmpegPath: string,
  imageUrl: string,
  targetBytes: number,
  profile: (typeof PROFILES)[number],
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let child: Pick<ChildProcess, 'stdout' | 'stderr' | 'once' | 'kill'>;
    try {
      child = spawnProcess(ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', imageUrl,
        '-frames:v', '1',
        '-vf', `scale=${profile.max_dimension}:${profile.max_dimension}:force_original_aspect_ratio=decrease`,
        '-q:v', String(profile.quality),
        '-pix_fmt', 'yuvj420p',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(error instanceof Error ? error : new Error('FFmpeg image process could not start'));
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
      else if (!bytes || bytes.length === 0) reject(new Error(stderr.trim() || 'FFmpeg returned no image'));
      else resolve(bytes);
    };

    const stdout = child.stdout;
    if (!stdout) {
      finish(new Error('FFmpeg image output is unavailable'));
      return;
    }
    stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > targetBytes) {
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
      finish(new Error('FFmpeg image compression timed out'));
    }, timeoutMs);
    child.once('error', (error) => finish(error instanceof Error ? error : new Error('FFmpeg image process failed')));
    child.once('close', (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || `FFmpeg exited with code ${code ?? 'unknown'}`));
        return;
      }
      finish(undefined, Buffer.concat(chunks, totalBytes));
    });
  });
}

export class FfmpegImageCompressor implements ImageCompressor {
  private readonly spawnProcess: FfmpegSpawn;

  constructor(
    private readonly ffmpegPath = 'ffmpeg',
    private readonly timeoutMs = 15_000,
    spawnProcess: FfmpegSpawn = spawn,
  ) {
    this.spawnProcess = spawnProcess;
  }

  async compress(input: ImageCompressionInput): Promise<CompressedImage> {
    const imageUrl = validateImageUrl(input.image_url);
    const targetBytes = validateTargetBytes(input.target_bytes);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('FFmpeg image compression timeout must be a positive integer');
    }

    for (const profile of PROFILES) {
      try {
        const bytes = await runAttempt(
          this.spawnProcess, this.ffmpegPath, imageUrl, targetBytes, profile, this.timeoutMs,
        );
        return { mime_type: 'image/jpeg', bytes };
      } catch (error) {
        if (error instanceof OutputTooLargeError) continue;
        throw error;
      }
    }
    throw new Error('FFmpeg could not compress the image below the requested limit');
  }
}
