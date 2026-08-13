import { NotFoundException } from '@nestjs/common';
import type { QueryResultRow } from 'pg';

import type { DatabaseClient } from '../database/database.client';

export interface VideoRecord {
  readonly video_id: string;
  readonly object_key: string;
  readonly duration_ms: number;
  readonly fps: number;
  readonly mime_type: 'video/mp4' | 'video/webm' | 'video/ogg';
}

export interface FrameRecord {
  readonly video_id: string;
  readonly keyframe_no: number;
  readonly original_frame_id: number;
  readonly timestamp_ms: number;
  readonly thumbnail_object_key: string;
}

export interface MediaRepository {
  findVideo(videoId: string): Promise<VideoRecord>;
  findFramesAround(videoId: string, centerFrameId: number, limit: number): Promise<FrameRecord[]>;
}

interface VideoRow extends QueryResultRow, VideoRecord {}
interface FrameRow extends QueryResultRow, FrameRecord {}

export class PostgresMediaRepository implements MediaRepository {
  constructor(private readonly database: DatabaseClient) {}

  async findVideo(videoId: string): Promise<VideoRecord> {
    const result = await this.database.query<VideoRow>(
      'SELECT video_id, object_key, duration_ms, fps, mime_type FROM videos WHERE video_id = $1',
      [videoId],
    );
    const video = result.rows[0];
    if (!video) throw new NotFoundException(`video ${videoId} was not found`);
    return video;
  }

  async findFramesAround(videoId: string, centerFrameId: number, limit: number): Promise<FrameRecord[]> {
    const result = await this.database.query<FrameRow>(`
      SELECT video_id, keyframe_no, original_frame_id, timestamp_ms, thumbnail_object_key
      FROM frames
      WHERE video_id = $1
      ORDER BY ABS(original_frame_id - $2), original_frame_id
      LIMIT $3`, [videoId, centerFrameId, limit]);
    return [...result.rows].sort((left, right) => left.original_frame_id - right.original_frame_id);
  }
}

export class UnavailableMediaRepository implements MediaRepository {
  async findVideo(_videoId: string): Promise<VideoRecord> {
    throw new NotFoundException('media catalog is not configured');
  }

  async findFramesAround(_videoId: string, _centerFrameId: number, _limit: number): Promise<FrameRecord[]> {
    throw new NotFoundException('media catalog is not configured');
  }
}
