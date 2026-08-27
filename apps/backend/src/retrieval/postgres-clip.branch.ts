import type { QueryResultRow } from 'pg';

import type { QueryEmbeddingProvider } from '../compute/model-ports';
import type { DatabaseClient } from '../database/database.client';
import type { BranchResult, RetrievalExecutionPlan } from '../common/types';
import type { RetrievalBranch } from './branch';

interface ClipRow extends QueryResultRow {
  readonly evidence_id: string;
  readonly video_id: string;
  readonly video_object_key: string | null;
  readonly keyframe_no: number | null;
  readonly original_frame_id: number | null;
  readonly timestamp_ms: number | null;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly preview_object_key: string | null;
  readonly rank_score: number | string;
}

export class PostgresClipBranch implements RetrievalBranch {
  readonly name = 'clip' as const;
  readonly available = true;

  constructor(
    private readonly database: DatabaseClient,
    private readonly encoder: QueryEmbeddingProvider,
    private readonly fixedEmbedding?: readonly number[],
  ) {}

  async search(query: string, plan: RetrievalExecutionPlan, signal?: AbortSignal): Promise<BranchResult> {
    const embedding = this.fixedEmbedding ?? await this.encoder.embedText(query);
    if (embedding.length !== this.encoder.dimensions) {
      throw new Error(`CLIP query embedding must have ${this.encoder.dimensions} dimensions`);
    }
    if (embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('CLIP query embedding must contain finite numbers');
    }
    const vector = `[${embedding.join(',')}]`;
    const result = await this.database.query<ClipRow>(`
      WITH top_clips AS (
        SELECT c.evidence_id, 1 - (c.embedding <=> $1::vector) AS rank_score
        FROM clip_embeddings c
        JOIN evidence e ON e.evidence_id = c.evidence_id
        JOIN feature_sets fs ON fs.feature_set_id = e.feature_set_id
        JOIN index_release_features irf
          ON irf.feature_set_id = fs.feature_set_id
         AND irf.dataset_version = fs.dataset_version
         AND irf.modality = fs.modality
        JOIN index_releases ir
          ON ir.index_version = irf.index_version
         AND ir.dataset_version = irf.dataset_version
        WHERE ir.status = 'active'
          AND ir.index_version = $3
          AND fs.modality = 'visual_embedding'
          AND fs.embedding_dimensions = $2
        ORDER BY c.embedding <=> $1::vector
        LIMIT $4
      )
      SELECT e.evidence_id, e.video_id, v.object_key AS video_object_key, f.keyframe_no, e.original_frame_id,
             f.timestamp_ms,
             e.start_ms, e.end_ms, f.thumbnail_object_key AS preview_object_key,
             tc.rank_score
      FROM top_clips tc
      JOIN evidence e ON e.evidence_id = tc.evidence_id
      JOIN videos v ON v.video_id = e.video_id
      LEFT JOIN frames f ON f.video_id = e.video_id AND f.original_frame_id = e.original_frame_id
      ORDER BY tc.rank_score DESC`, [vector, this.encoder.dimensions, plan.index_version, plan.top_k_per_branch], {
        statementTimeoutMs: plan.latency_budget_ms,
        ...(signal ? { signal } : {}),
      });
    return {
      query_id: plan.query_id, branch: this.name, status: 'completed', query_variant: query,
      candidates: result.rows.map((row, index) => ({
        video_id: row.video_id,
        ...(row.video_object_key ? { video_object_key: row.video_object_key } : {}),
        rank: index + 1, raw_score: Number(row.rank_score),
        keyframe_no: row.keyframe_no,
        original_frame_id: row.original_frame_id,
        ...(row.timestamp_ms === null || row.timestamp_ms === undefined ? {} : { timestamp_ms: Number(row.timestamp_ms) }),
        start_ms: Number(row.start_ms), end_ms: Number(row.end_ms),
        preview_uri: row.preview_object_key ? `r2://media/${row.preview_object_key}` : undefined,
        evidence_ids: [row.evidence_id],
      })),
      elapsed_ms: 0, deadline_ms: plan.latency_budget_ms, index_version: plan.index_version,
      producer: 'postgres-clip-vector',
    };
  }
}
