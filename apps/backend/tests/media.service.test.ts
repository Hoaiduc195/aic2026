import { describe, expect, it, vi } from 'vitest';

import type { MediaRepository } from '../src/media/media.repository';
import { MediaService } from '../src/media/media.service';
import type { ObjectStorage } from '../src/storage/object-storage';

const repository: MediaRepository = {
  findVideo: vi.fn(async () => ({
    video_id: 'video-1', object_key: 'videos/video-1.mp4', duration_ms: 60000,
    fps: 25, mime_type: 'video/mp4' as const,
  })),
  findFramesAround: vi.fn(async () => [{
    video_id: 'video-1', keyframe_no: 2, original_frame_id: 50,
    timestamp_ms: 2000, thumbnail_object_key: 'keyframes/video-1/000050.jpg',
  }]),
};

const storage: ObjectStorage = {
  isConfigured: true,
  signReadUrl: vi.fn(async (key) => `https://media.example/${key}`),
  health: vi.fn(async () => true),
};

describe('MediaService', () => {
  it('returns signed video playback metadata', async () => {
    const service = new MediaService(repository, storage);
    await expect(service.getPlayback('video-1')).resolves.toEqual({
      video_id: 'video-1', playback_uri: 'https://media.example/videos/video-1.mp4',
      duration_ms: 60000, fps: 25, mime_type: 'video/mp4',
    });
  });

  it('returns signed neighboring keyframes', async () => {
    const service = new MediaService(repository, storage);
    const result = await service.getFrames('video-1', 50, 25);
    expect(result.frames[0].thumbnail_uri).toBe('https://media.example/keyframes/video-1/000050.jpg');
  });
});
