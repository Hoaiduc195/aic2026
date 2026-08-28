import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '../src/database/database.client';
import { PostgresMediaRepository, UnavailableMediaRepository } from '../src/media/media.repository';

function db(rows: never[]): DatabaseClient {
  return { isConfigured: true, health: vi.fn(async () => true), query: vi.fn(async () => ({ rows, rowCount: rows.length })) };
}

describe('media repositories', () => {
  it('loads a video and sorts nearest keyframes chronologically', async () => {
    const database = db([{ video_id: 'v', object_key: 'videos/v.mp4', duration_ms: 10, fps: 25, mime_type: 'video/mp4' }] as never[]);
    const repository = new PostgresMediaRepository(database);
    await expect(repository.findVideo('v')).resolves.toMatchObject({ object_key: 'videos/v.mp4' });
    expect(vi.mocked(database.query).mock.calls[0][1]).toEqual(['v']);

    vi.mocked(database.query).mockResolvedValueOnce({ rows: [
      { video_id: 'v', keyframe_no: 2, original_frame_id: 20, timestamp_ms: 20, thumbnail_object_key: 'b' },
      { video_id: 'v', keyframe_no: 1, original_frame_id: 10, timestamp_ms: 10, thumbnail_object_key: 'a' },
    ] as never[], rowCount: 2 });
    const frames = await repository.findFramesAround('v', 15, 2);
    expect(frames.map((frame) => frame.original_frame_id)).toEqual([10, 20]);
  });

  it('selects spaced keyframes around the center when a source-frame step is requested', async () => {
    const database = db([
      { video_id: 'v', keyframe_no: 1, original_frame_id: 0, timestamp_ms: 0, thumbnail_object_key: 'a' },
      { video_id: 'v', keyframe_no: 2, original_frame_id: 90, timestamp_ms: 3_000, thumbnail_object_key: 'b' },
      { video_id: 'v', keyframe_no: 3, original_frame_id: 180, timestamp_ms: 6_000, thumbnail_object_key: 'c' },
      { video_id: 'v', keyframe_no: 4, original_frame_id: 270, timestamp_ms: 9_000, thumbnail_object_key: 'd' },
      { video_id: 'v', keyframe_no: 5, original_frame_id: 360, timestamp_ms: 12_000, thumbnail_object_key: 'e' },
    ] as never[]);
    const repository = new PostgresMediaRepository(database);

    const frames = await repository.findFramesAround('v', 180, 3, 90);

    expect(frames.map((frame) => frame.original_frame_id)).toEqual([90, 180, 270]);
    expect(vi.mocked(database.query).mock.calls[0][1]).toEqual(['v']);
  });

  it('finds a canonical frame by its keyframe ordinal', async () => {
    const database = db([{
      video_id: 'v', keyframe_no: 7, original_frame_id: 385, timestamp_ms: 12_833,
      thumbnail_object_key: 'keyframes/v/007.jpg',
    }] as never[]);
    const repository = new PostgresMediaRepository(database);

    await expect(repository.findFrameByKeyframe('v', 7)).resolves.toMatchObject({
      video_id: 'v', original_frame_id: 385, keyframe_no: 7,
    });
    expect(vi.mocked(database.query).mock.calls[0][1]).toEqual(['v', 7]);
  });

  it('returns clear not-found failures', async () => {
    await expect(new PostgresMediaRepository(db([])).findVideo('missing')).rejects.toThrow('not found');
    const unavailable = new UnavailableMediaRepository();
    await expect(unavailable.findVideo('v')).rejects.toThrow('not configured');
    await expect(unavailable.findFramesAround('v', 1, 1)).rejects.toThrow('not configured');
    await expect(unavailable.findFrameByKeyframe('v', 1)).rejects.toThrow('not configured');
  });
});
