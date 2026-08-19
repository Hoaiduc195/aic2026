import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaRepository } from '../src/media/media.repository';
import type { FrameDecoder } from '../src/media/frame-decoder';
import type { ImageCompressor } from '../src/media/image-compressor';
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
  findFrame: vi.fn(async () => null),
  findNearestStudioFrame: vi.fn(async () => ({
    video_id: 'video-1', keyframe_no: 2, original_frame_id: 50, timestamp_ms: 2000,
    captions: [{ evidence_id: 'caption-1', text: 'a person', language: 'en', producer: 'caption:v1' }],
    objects: [{
      evidence_id: 'object-1', label: 'person', confidence: 0.9,
      normalized_bbox: [0.1, 0.2, 0.3, 0.4] as [number, number, number, number], producer: 'object:v1',
    }],
  })),
  findStudio: vi.fn(async () => ({
    video: {
      video_id: 'video-1', object_key: 'videos/video-1.mp4', duration_ms: 60000,
      fps: 25, mime_type: 'video/mp4' as const,
    },
    frames: [{
      video_id: 'video-1', keyframe_no: 2, original_frame_id: 50, timestamp_ms: 2000,
      captions: [], objects: [],
    }],
    asr_spans: [{
      evidence_id: 'asr-1', start_ms: 1000, end_ms: 3000,
      text: 'Xin chào', language: 'vi', producer: 'asr:v1',
    }],
  })),
};

const storage: ObjectStorage = {
  isConfigured: true,
  signReadUrl: vi.fn(async (key) => `https://media.example/${key}`),
  health: vi.fn(async () => true),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MediaService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('signs only the video in the studio response and leaves thumbnails lazy', async () => {
    const service = new MediaService(repository, storage);
    const result = await service.getStudio('video-1');

    expect(result.video.playback_uri).toBe('https://media.example/videos/video-1.mp4');
    expect(result.frames[0]).not.toHaveProperty('thumbnail_uri');
    expect(result.asr_spans[0]).toMatchObject({ text: 'Xin chào', start_ms: 1000, end_ms: 3000 });
    expect(storage.signReadUrl).toHaveBeenCalledTimes(1);
  });

  it('returns an exact source-frame selection with nearest annotations', async () => {
    const decoder: FrameDecoder = {
      decode: vi.fn(async () => ({ mime_type: 'image/jpeg' as const, bytes: Buffer.from('exact-frame') })),
    };
    const service = new MediaService(repository, storage, decoder);

    const result = await service.getFrame('video-1', 51);

    expect(result).toMatchObject({
      video_id: 'video-1',
      original_frame_id: 51,
      keyframe_no: null,
      annotation_source_frame_id: 50,
      captions: [{ text: 'a person' }],
      objects: [{ label: 'person' }],
    });
  });

  it('preserves the stored keyframe image content type for exact sparse frames', async () => {
    vi.mocked(repository.findFrame).mockResolvedValueOnce({
      video_id: 'video-1', keyframe_no: 2, original_frame_id: 50,
      timestamp_ms: 2000, thumbnail_object_key: 'keyframes/video-1/000050.webp',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('webp-bytes'), {
      status: 200,
      headers: { 'content-type': 'image/webp' },
    })));
    const service = new MediaService(repository, storage);

    await expect(service.getFrameThumbnail('video-1', 50)).resolves.toEqual({
      mime_type: 'image/webp', bytes: Buffer.from('webp-bytes'),
    });
  });

  it('compresses an oversized sparse thumbnail before falling back to source-frame decoding', async () => {
    vi.mocked(repository.findFrame).mockResolvedValueOnce({
      video_id: 'video-1', keyframe_no: 2, original_frame_id: 50,
      timestamp_ms: 2000, thumbnail_object_key: 'keyframes/video-1/000050.jpg',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(12 * 1024 * 1024 + 1),
      },
    })));
    const compressor: ImageCompressor = {
      compress: vi.fn(async () => ({ mime_type: 'image/jpeg' as const, bytes: Buffer.from('compressed') })),
    };
    const service = new MediaService(repository, storage, undefined, compressor);

    await expect(service.getFrameThumbnail('video-1', 50)).resolves.toEqual({
      mime_type: 'image/jpeg', bytes: Buffer.from('compressed'),
    });
    expect(compressor.compress).toHaveBeenCalledWith(expect.objectContaining({
      image_url: 'https://media.example/keyframes/video-1/000050.jpg',
    }));
  });

  it('decodes exact frames as JPEG bytes for the thumbnail endpoint', async () => {
    const decoder: FrameDecoder = {
      decode: vi.fn(async () => ({ mime_type: 'image/jpeg' as const, bytes: Buffer.from('exact-frame') })),
    };
    const service = new MediaService(repository, storage, decoder);

    await expect(service.getFrameThumbnail('video-1', 51)).resolves.toEqual({
      mime_type: 'image/jpeg',
      bytes: Buffer.from('exact-frame'),
    });
    expect(decoder.decode).toHaveBeenCalledWith(expect.objectContaining({
      video_url: 'https://media.example/videos/video-1.mp4',
      original_frame_id: 51,
      fps: 25,
    }));
  });
});
