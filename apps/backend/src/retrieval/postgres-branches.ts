import type { QueryResultRow } from 'pg';

import type { DatabaseClient } from '../database/database.client';
import type { BranchCandidate, BranchName, BranchResult, RetrievalExecutionPlan } from '../common/types';
import type { RetrievalBranch } from './branch';

interface CandidateRow extends QueryResultRow {
  readonly evidence_id: string;
  readonly segment_id: string;
  readonly video_id: string;
  readonly original_frame_id: number | null;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly preview_object_key: string | null;
  readonly rank_score: number | string;
  readonly matched_label?: string;
}

function previewUri(key: string | null): string | undefined {
  return key ? `r2://media/${key}` : undefined;
}

function candidatesFromRows(rows: readonly CandidateRow[]): BranchCandidate[] {
  return rows.map((row, index) => ({
    segment_id: row.segment_id,
    video_id: row.video_id,
    rank: index + 1,
    raw_score: Number(row.rank_score),
    original_frame_id: row.original_frame_id,
    start_ms: Number(row.start_ms),
    end_ms: Number(row.end_ms),
    preview_uri: previewUri(row.preview_object_key),
    evidence_ids: [row.evidence_id],
    matched_terms: row.matched_label ? [row.matched_label] : undefined,
  }));
}

abstract class PostgresBranch implements RetrievalBranch {
  abstract readonly name: BranchName;
  abstract search(query: string, plan: RetrievalExecutionPlan): Promise<BranchResult>;
  protected constructor(protected readonly database: DatabaseClient) {}

  protected completed(plan: RetrievalExecutionPlan, query: string, rows: readonly CandidateRow[], producer: string): BranchResult {
    return {
      query_id: plan.query_id,
      branch: this.name,
      status: 'completed',
      query_variant: query,
      candidates: candidatesFromRows(rows),
      elapsed_ms: 0,
      deadline_ms: plan.latency_budget_ms,
      index_version: plan.index_version,
      producer,
    };
  }
}

export class PostgresTextBranch extends PostgresBranch {
  constructor(
    public readonly name: Extract<BranchName, 'caption' | 'asr_lexical' | 'ocr_lexical'>,
    private readonly evidenceType: 'caption' | 'asr' | 'ocr',
    database: DatabaseClient,
  ) {
    super(database);
  }

  async search(query: string, plan: RetrievalExecutionPlan): Promise<BranchResult> {
    const result = await this.database.query<CandidateRow>(`
      WITH query AS (SELECT websearch_to_tsquery('simple', $1) AS value)
      SELECT e.evidence_id, e.segment_id, e.video_id, e.original_frame_id,
             e.start_ms, e.end_ms, f.thumbnail_object_key AS preview_object_key,
             GREATEST(
               ts_rank_cd(t.search_document, query.value),
               similarity(lower(t.text_content), lower($1))
             ) AS rank_score
      FROM text_evidence t
      JOIN evidence e ON e.evidence_id = t.evidence_id
      LEFT JOIN frames f ON f.video_id = e.video_id AND f.original_frame_id = e.original_frame_id
      CROSS JOIN query
      WHERE (t.search_document @@ query.value OR similarity(lower(t.text_content), lower($1)) > 0.15)
        AND e.evidence_type = $2
      ORDER BY rank_score DESC, e.video_id, e.start_ms
      LIMIT $3`, [query, this.evidenceType, plan.top_k_per_branch]);
    return this.completed(plan, query, result.rows, `postgres-${this.evidenceType}-fts`);
  }
}

export class PostgresObjectBranch extends PostgresBranch {
  readonly name = 'object' as const;

  constructor(database: DatabaseClient) {
    super(database);
  }

  async search(query: string, plan: RetrievalExecutionPlan): Promise<BranchResult> {
    const result = await this.database.query<CandidateRow>(`
      SELECT e.evidence_id, e.segment_id, e.video_id, e.original_frame_id,
             e.start_ms, e.end_ms, f.thumbnail_object_key AS preview_object_key,
             GREATEST(similarity(o.normalized_label, lower($1)), o.confidence) AS rank_score,
             o.label AS matched_label
      FROM object_evidence o
      JOIN evidence e ON e.evidence_id = o.evidence_id
      LEFT JOIN frames f ON f.video_id = e.video_id AND f.original_frame_id = e.original_frame_id
      WHERE o.normalized_label % lower($1) OR lower($1) LIKE '%' || o.normalized_label || '%'
      ORDER BY rank_score DESC, e.video_id, e.start_ms
      LIMIT $2`, [query, plan.top_k_per_branch]);
    return this.completed(plan, query, result.rows, 'postgres-object-trigram');
  }
}
