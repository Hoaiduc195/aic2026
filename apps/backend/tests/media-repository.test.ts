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

  it('returns clear not-found failures', async () => {
    await expect(new PostgresMediaRepository(db([])).findVideo('missing')).rejects.toThrow('not found');
    const unavailable = new UnavailableMediaRepository();
    await expect(unavailable.findVideo('v')).rejects.toThrow('not configured');
    await expect(unavailable.findFramesAround('v', 1, 1)).rejects.toThrow('not configured');
  });
});
