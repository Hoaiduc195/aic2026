import { describe, expect, it } from 'vitest';

import { checkTrakeSequence, getFrameContextBatch, getVideoContext } from '../src/context-service.js';
import type { BackendClientPort, BackendFrame } from '../src/types.js';

const playback = { video_id: 'video-1', playback_uri: 'https://signed.example/video.mp4', duration_ms: 5000, fps: 25, mime_type: 'video/mp4' as const };

function frame(frameId: number, text: string): BackendFrame {
  return {
    video_id: 'video-1', keyframe_no: frameId + 1, original_frame_id: frameId, timestamp_ms: frameId * 100,
    captions: [{ evidence_id: `e-${frameId}`, text, language: 'en', producer: 'test' }], ocr: [], objects: [],
    thumbnail_uri: 'https://signed.example/frame.jpg', is_exact_frame: true, annotation_source_frame_id: frameId, asr_spans: [],
  };
}

function backend(): BackendClientPort {
  return {
    searchFrames: async () => ({ query_id: 'q', results: [], warnings: [] }),
    planSearch: async () => { throw new Error('unused'); },
    searchExactFrames: async () => ({ query_id: 'q', results: [], warnings: [] }),
    getFrame: async (ref) => frame(ref.originalFrameId ?? 0, `event ${ref.originalFrameId ?? 0}`),
    getFrameImage: async () => ({ bytes: Buffer.from([1, 2]), mimeType: 'image/jpeg' }),
    getNearbyFrames: async () => ({ video_id: 'video-1', center_frame_id: 10, frames: [] }),
    getVideo: async () => playback,
    getStudio: async () => ({ video: playback, frames: [], asr_spans: [] }),
    getVqaAnswer: async () => { throw new Error('unused'); },
    getCandidates: async () => { throw new Error('unused'); },
    getSelection: async () => null,
    previewSubmission: async () => { throw new Error('unused'); },
    getHealth: async () => ({ status: 'ok', service: 'test', mode: 'test', dependencies: {}, retrieval_branches: [], task_executors: [] }),
  };
}

describe('context service', () => {
  it('loads a bounded batch of exact evidence and optional images', async () => {
    const result = await getFrameContextBatch(backend(), [
      { videoId: 'video-1', originalFrameId: 10 },
      { videoId: 'video-1', originalFrameId: 20 },
    ], true);

    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]?.frame?.original_frame_id).toBe(10);
    expect(result.frames[0]?.image?.bytes).toEqual(Buffer.from([1, 2]));
  });

  it('combines video, studio and nearby context', async () => {
    const result = await getVideoContext(backend(), { videoId: 'video-1', centerFrameId: 10, nearbyLimit: 4, includeStudio: true });
    expect(result.video.video_id).toBe('video-1');
    expect(result.studio?.video.video_id).toBe('video-1');
    expect(result.nearby?.center_frame_id).toBe(10);
  });

  it('reuses the TRAKE coverage algorithm for four exact frames', async () => {
    const result = await checkTrakeSequence(backend(), ['event 10', 'event 20', 'event 30', 'event 40'], [
      { videoId: 'video-1', originalFrameId: 10 },
      { videoId: 'video-1', originalFrameId: 20 },
      { videoId: 'video-1', originalFrameId: 30 },
      { videoId: 'video-1', originalFrameId: 40 },
    ]);
    expect(result.coverage.coveredEvents).toEqual([0, 1, 2, 3]);
    expect(result.coverage.chronological).toBe(true);
  });
});
