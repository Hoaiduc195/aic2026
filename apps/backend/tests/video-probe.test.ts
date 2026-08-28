import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { FfprobeVideoProbe } from '../src/media/video-probe';

function fakeProbeProcess(frameCount: number) {
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
    process.stdout.emit('data', Buffer.from(JSON.stringify({
      streams: [{ nb_read_frames: String(frameCount) }],
    })));
    process.emit('close', 0);
  });
  return process;
}

describe('FfprobeVideoProbe', () => {
  it('counts every decoded source frame and returns an exact integer', async () => {
    const spawn = vi.fn(() => fakeProbeProcess(37_849));
    const probe = new FfprobeVideoProbe('ffprobe', 1_000, spawn as never);

    await expect(probe.countFrames('https://signed.example/video.mp4')).resolves.toBe(37_849);

    expect(spawn).toHaveBeenCalledWith('ffprobe', expect.arrayContaining([
      '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames',
    ]), expect.objectContaining({ windowsHide: true }));
  });
});
