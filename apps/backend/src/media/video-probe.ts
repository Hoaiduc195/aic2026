import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import type { FfmpegSpawn } from './image-compressor';

export interface VideoProbe {
  countFrames(videoUrl: string): Promise<number>;
}

export class FfprobeVideoProbe implements VideoProbe {
  constructor(
    private readonly ffprobePath = 'ffprobe',
    private readonly timeoutMs = 20 * 60_000,
    private readonly spawnProcess: FfmpegSpawn = spawn,
  ) {}

  countFrames(videoUrl: string): Promise<number> {
    if (!videoUrl.trim()) return Promise.reject(new Error('video URL is required'));
    return new Promise<number>((resolve, reject) => {
      let child: Pick<ChildProcess, 'stdout' | 'stderr' | 'once' | 'kill'>;
      try {
        child = this.spawnProcess(this.ffprobePath, [
          '-v', 'error',
          '-count_frames',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=nb_read_frames',
          '-of', 'json',
          videoUrl,
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        reject(error instanceof Error ? error : new Error('FFprobe process could not start'));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('FFprobe frame count timed out'));
      }, this.timeoutMs);
      const finish = (error?: Error, count?: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else if (!Number.isSafeInteger(count) || count! <= 0) reject(new Error('FFprobe returned an invalid frame count'));
        else resolve(count!);
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < 64 * 1024) stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 8 * 1024) stderr += chunk.toString('utf8');
      });
      child.once('error', (error) => finish(error instanceof Error ? error : new Error('FFprobe failed')));
      child.once('close', (code) => {
        if (code !== 0) {
          finish(new Error(stderr.trim() || `FFprobe exited with code ${code ?? 'unknown'}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { streams?: Array<{ nb_read_frames?: string }> };
          const count = Number(parsed.streams?.[0]?.nb_read_frames);
          finish(undefined, count);
        } catch {
          finish(new Error('FFprobe returned malformed JSON'));
        }
      });
    });
  }
}
