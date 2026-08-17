import { ServiceUnavailableException } from '@nestjs/common';
import type { QueryResultRow } from 'pg';

import type { DatabaseClient } from '../../database/database.client';

export interface VqaGroundingEvidence {
  readonly evidence_id: string;
  readonly type: string;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly snippet: string | null;
  readonly producer: string;
}

export interface VqaGroundingContext {
  readonly query_id: string;
  readonly task: 'vqa';
  readonly video_id: string;
  readonly original_frame_id: number;
  readonly timestamp_ms: number;
  readonly thumbnail_object_key?: string | null;
  readonly evidence: readonly VqaGroundingEvidence[];
}

export interface VqaGroundingRepository {
  find(queryId: string, videoId: string, originalFrameId: number): Promise<VqaGroundingContext | null>;
}

interface VqaGroundingRow extends QueryResultRow {
  readonly query_id: string;
  readonly task: string;
  readonly video_id: string;
  readonly original_frame_id: number;
  readonly timestamp_ms: number;
  readonly evidence_id: string | null;
  readonly type: string | null;
  readonly start_ms: number | null;
  readonly end_ms: number | null;
  readonly snippet: string | null;
  readonly producer: string | null;
}

export class PostgresVqaGroundingRepository implements VqaGroundingRepository {
  constructor(private readonly database: DatabaseClient) {}

  async find(queryId: string, videoId: string, originalFrameId: number): Promise<VqaGroundingContext | null> {
    const result = await this.database.query<VqaGroundingRow & { thumbnail_object_key?: string | null }>(`
      SELECT r.query_id, r.task, f.video_id, f.original_frame_id, f.timestamp_ms, f.thumbnail_object_key,
             e.evidence_id, e.evidence_type AS type, e.start_ms, e.end_ms,
             COALESCE(t.text_content, o.label, e.payload->>'snippet') AS snippet,
             COALESCE(fs.producer, 'unknown') AS producer
      FROM retrieval_runs r
      JOIN frames f ON f.video_id = $2 AND f.original_frame_id = $3
      LEFT JOIN evidence e
        ON e.video_id = f.video_id
       AND e.original_frame_id = f.original_frame_id
      LEFT JOIN feature_sets fs ON fs.feature_set_id = e.feature_set_id
      LEFT JOIN text_evidence t ON t.evidence_id = e.evidence_id
      LEFT JOIN object_evidence o ON o.evidence_id = e.evidence_id
      WHERE r.query_id = $1 AND r.task = 'vqa'
      ORDER BY e.evidence_id NULLS LAST`, [queryId, videoId, originalFrameId]);

    const first = result.rows[0];
    if (!first) return null;
    return {
      query_id: first.query_id,
      task: 'vqa',
      video_id: first.video_id,
      original_frame_id: Number(first.original_frame_id),
      timestamp_ms: Number(first.timestamp_ms),
      thumbnail_object_key: first.thumbnail_object_key,
      evidence: result.rows
        .filter((row) => row.evidence_id && row.type && row.start_ms !== null && row.end_ms !== null)
        .map((row) => ({
          evidence_id: row.evidence_id as string,
          type: row.type as string,
          start_ms: Number(row.start_ms),
          end_ms: Number(row.end_ms),
          snippet: row.snippet,
          producer: row.producer ?? 'unknown',
        })),
    };
  }
}

export class UnavailableVqaGroundingRepository implements VqaGroundingRepository {
  async find(_queryId: string, _videoId: string, _originalFrameId: number): Promise<VqaGroundingContext | null> {
    throw new ServiceUnavailableException('VQA grounding database is not configured');
  }
}
