import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '../src/database/database.client';
import { PostgresMediaRepository } from '../src/media/media.repository';

function database(): DatabaseClient {
  return {
    isConfigured: true,
    health: vi.fn(async () => true),
    query: vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          video_id: 'video-1',
          object_key: 'videos/video-1.mp4',
          original_filename: 'video-1.mp4',
          storage_uri: 'r2://media/videos/video-1.mp4',
          duration_ms: 60_000,
          fps: 25,
          mime_type: 'video/mp4',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          { video_id: 'video-1', keyframe_no: 1, original_frame_id: 0, timestamp_ms: 0 },
          { video_id: 'video-1', keyframe_no: 2, original_frame_id: 50, timestamp_ms: 2_000 },
        ],
        rowCount: 2,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            evidence_id: 'caption-1', evidence_type: 'caption', original_frame_id: 50,
            text_content: 'Two presenters stand behind a desk.', language: 'en', producer: 'caption:v1',
            label: null, confidence: null, normalized_bbox: null,
          },
          {
            evidence_id: 'object-1', evidence_type: 'object', original_frame_id: 50,
            text_content: null, language: null, producer: 'object:v1',
            label: 'person', confidence: 0.91, normalized_bbox: [0.1, 0.2, 0.3, 0.4],
          },
          {
            evidence_id: 'ocr-1', evidence_type: 'ocr', original_frame_id: 50,
            text_content: 'GIẢM GIÁ 50%', language: 'vi', producer: 'ocr:v1',
            label: null, confidence: null, normalized_bbox: null,
          },
        ],
        rowCount: 2,
      })
      .mockResolvedValueOnce({
        rows: [{
          evidence_id: 'asr-1', start_ms: 1_000, end_ms: 3_000,
          text_content: 'Xin chào quý vị.', language: 'vi', producer: 'asr:v1',
        }],
        rowCount: 1,
      }),
  };
}

describe('video studio media repository', () => {
  it('assembles frame metadata, OCR/caption/object annotations and ASR spans', async () => {
    const databaseClient = database();
    const studio = await new PostgresMediaRepository(databaseClient).findStudio('video-1');

    expect(studio.video).toMatchObject({ video_id: 'video-1', object_key: 'videos/video-1.mp4' });
    expect(studio.frames).toHaveLength(2);
    expect(studio.frames[1]).toMatchObject({
      original_frame_id: 50,
      captions: [{ evidence_id: 'caption-1', text: 'Two presenters stand behind a desk.', language: 'en' }],
      ocr: [{ evidence_id: 'ocr-1', text: 'GIẢM GIÁ 50%', language: 'vi', producer: 'ocr:v1' }],
      objects: [{
        evidence_id: 'object-1', label: 'person', confidence: 0.91,
        normalized_bbox: [0.1, 0.2, 0.3, 0.4],
      }],
    });
    expect(studio.asr_spans).toEqual([{
      evidence_id: 'asr-1', start_ms: 1_000, end_ms: 3_000,
      text: 'Xin chào quý vị.', language: 'vi', producer: 'asr:v1',
    }]);

    const calls = vi.mocked(databaseClient.query).mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[2][0]).toContain("e.evidence_type IN ('caption', 'object', 'ocr')");
    expect(calls[2][0]).toContain("t.language = 'en'");
    expect(calls[2][0]).toContain("ir.status = 'active'");
    expect(calls[3][0]).toContain("e.evidence_type = 'asr'");
  });

  it('rejects a missing video before assembling studio annotations', async () => {
    const databaseClient: DatabaseClient = {
      isConfigured: true,
      health: vi.fn(async () => true),
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    };

    await expect(new PostgresMediaRepository(databaseClient).findStudio('missing')).rejects.toThrow('not found');
    expect(databaseClient.query).toHaveBeenCalledOnce();
  });
});
