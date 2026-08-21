import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { FfmpegFrameDecoder } from '../src/media/frame-decoder';

function fakeProcess(outputBytes: number): EventEmitter & {
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const process = new EventEmitter() as EventEmitter & {
    readonly stdout: EventEmitter;
    readonly stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  Object.assign(process, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    process.stdout.emit('data', Buffer.alloc(outputBytes, 0x01));
    process.emit('close', 0);
  });
  return process;
}

describe('FfmpegFrameDecoder', () => {
  it('re-encodes a large exact frame with smaller profiles instead of dropping it', async () => {
    let attempt = 0;
    const spawn = vi.fn((_command: string, _args: string[], _options: unknown) => fakeProcess(attempt++ === 0 ? 101 : 32));
    const decoder = new FfmpegFrameDecoder('ffmpeg', 1_000, spawn as never);

    await expect(decoder.decode({
      video_url: 'https://signed.example/videos/video-1.mp4',
      original_frame_id: 42,
      fps: 25,
      max_bytes: 100,
    })).resolves.toEqual({ mime_type: 'image/jpeg', bytes: Buffer.alloc(32, 0x01) });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['-q:v', '5']));
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining([
      expect.stringContaining('select=eq(n\\,42)'),
    ]));
  });
});
