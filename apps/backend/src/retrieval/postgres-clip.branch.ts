import type { QueryResultRow } from 'pg';

import type { QueryEmbeddingProvider } from '../compute/model-ports';
import type { DatabaseClient } from '../database/database.client';
import type { BranchResult, RetrievalExecutionPlan } from '../common/types';
import type { RetrievalBranch } from './branch';

interface ClipRow extends QueryResultRow {
  readonly evidence_id: string;
  readonly segment_id: string;
  readonly video_id: string;
  readonly original_frame_id: number | null;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly preview_object_key: string | null;
  readonly rank_score: number | string;
}

export class PostgresClipBranch implements RetrievalBranch {
  readonly name = 'clip' as const;

  constructor(private readonly database: DatabaseClient, private readonly encoder: QueryEmbeddingProvider) {}

  async search(query: string, plan: RetrievalExecutionPlan): Promise<BranchResult> {
    const embedding = await this.encoder.embedText(query);
    if (embedding.length !== 512) throw new Error('CLIP query embedding must have 512 dimensions');
    const vector = `[${embedding.join(',')}]`;
    const result = await this.database.query<ClipRow>(`
      SELECT e.evidence_id, e.segment_id, e.video_id, e.original_frame_id,
             e.start_ms, e.end_ms, f.thumbnail_object_key AS preview_object_key,
             1 - (c.embedding <=> $1::vector) AS rank_score
      FROM clip_embeddings c
      JOIN evidence e ON e.evidence_id = c.evidence_id
      LEFT JOIN frames f ON f.video_id = e.video_id AND f.original_frame_id = e.original_frame_id
      ORDER BY c.embedding <=> $1::vector, e.video_id, e.start_ms
      LIMIT $2`, [vector, plan.top_k_per_branch]);
    return {
      query_id: plan.query_id, branch: this.name, status: 'completed', query_variant: query,
      candidates: result.rows.map((row, index) => ({
        segment_id: row.segment_id, video_id: row.video_id, rank: index + 1, raw_score: Number(row.rank_score),
        original_frame_id: row.original_frame_id, start_ms: Number(row.start_ms), end_ms: Number(row.end_ms),
        preview_uri: row.preview_object_key ? `r2://media/${row.preview_object_key}` : undefined,
        evidence_ids: [row.evidence_id],
      })),
      elapsed_ms: 0, deadline_ms: plan.latency_budget_ms, index_version: plan.index_version,
      producer: 'postgres-clip-vector',
    };
  }
}
