import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { FfmpegImageCompressor } from '../src/media/image-compressor';

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

describe('FfmpegImageCompressor', () => {
  it('retries with a smaller profile until the JPEG is under the requested limit', async () => {
    let attempt = 0;
    const spawn = vi.fn((_command: string, _args: string[], _options: unknown) => fakeProcess(attempt++ === 0 ? 101 : 32));
    const compressor = new FfmpegImageCompressor('ffmpeg', 1_000, spawn as never);

    await expect(compressor.compress({
      image_url: 'https://signed.example/keyframes/video-1/42.webp',
      target_bytes: 100,
    })).resolves.toEqual({ mime_type: 'image/jpeg', bytes: Buffer.alloc(32, 0x01) });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '-i', 'https://signed.example/keyframes/video-1/42.webp',
      '-q:v', '5',
    ]));
    expect(spawn.mock.calls[0][1]).not.toContain('-hide_banner');
  });

  it('rejects non-http image URLs before invoking FFmpeg', async () => {
    const spawn = vi.fn((_command: string, _args: string[], _options: unknown) => fakeProcess(32));
    const compressor = new FfmpegImageCompressor('ffmpeg', 1_000, spawn as never);

    await expect(compressor.compress({ image_url: 'file:///tmp/frame.jpg' }))
      .rejects.toThrow('image URL must use HTTP(S)');
    expect(spawn).not.toHaveBeenCalled();
  });
});
