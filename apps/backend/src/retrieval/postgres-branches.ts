import type { QueryResultRow } from 'pg';

import type { DatabaseClient } from '../database/database.client';
import type { BranchCandidate, BranchName, BranchResult, RetrievalExecutionPlan } from '../common/types';
import type { RetrievalBranch } from './branch';
import { normalizeRetrievalText } from './query-planner';

interface CandidateRow extends QueryResultRow {
  readonly evidence_id: string;
  readonly video_id: string;
  readonly video_object_key: string | null;
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
    video_id: row.video_id,
    ...(row.video_object_key ? { video_object_key: row.video_object_key } : {}),
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
  readonly available = true;
  abstract readonly name: BranchName;
  abstract search(query: string, plan: RetrievalExecutionPlan): Promise<BranchResult>;
  protected constructor(protected readonly database: DatabaseClient) {}

  protected completed(
    plan: RetrievalExecutionPlan,
    query: string,
    rows: readonly CandidateRow[],
    producer: string,
    retrievalMode: string,
    scoringComponents: string[],
  ): BranchResult {
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
      diagnostics: {
        retrieval_mode: retrievalMode,
        normalized_query: query,
        candidate_count: rows.length,
        scoring_components: scoringComponents,
      },
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
    const normalizedQuery = normalizeRetrievalText(query).toLowerCase();
    const result = await this.database.query<CandidateRow>(`
      WITH query AS (SELECT websearch_to_tsquery('simple', $1) AS value)
      SELECT e.evidence_id, e.video_id, v.object_key AS video_object_key, e.original_frame_id,
             e.start_ms, e.end_ms, f.thumbnail_object_key AS preview_object_key,
             GREATEST(
               ts_rank_cd(t.search_document, query.value),
               similarity(lower(t.text_content), lower($1))
             ) + CASE WHEN lower(t.text_content) LIKE '%' || lower($1) || '%' THEN 0.25 ELSE 0 END AS rank_score
      FROM text_evidence t
      JOIN evidence e ON e.evidence_id = t.evidence_id
      JOIN videos v ON v.video_id = e.video_id
      JOIN feature_sets fs ON fs.feature_set_id = e.feature_set_id
      JOIN index_release_features irf
        ON irf.feature_set_id = fs.feature_set_id
       AND irf.dataset_version = fs.dataset_version
       AND irf.modality = fs.modality
      JOIN index_releases ir
        ON ir.index_version = irf.index_version
       AND ir.dataset_version = irf.dataset_version
      LEFT JOIN frames f ON f.video_id = e.video_id AND f.original_frame_id = e.original_frame_id
      CROSS JOIN query
      WHERE (t.search_document @@ query.value OR similarity(lower(t.text_content), lower($1)) > 0.15)
        AND e.evidence_type = $2
        AND ir.status = 'active'
        AND ir.index_version = $3
      ORDER BY rank_score DESC, e.video_id, e.start_ms, e.evidence_id
      LIMIT $4`, [normalizedQuery, this.evidenceType, plan.index_version, plan.top_k_per_branch]);
    return this.completed(
      plan,
      normalizedQuery,
      result.rows,
      `postgres-${this.evidenceType}-lexical-v2`,
      'lexical_fts_trigram_exact',
      ['postgres_fts', 'pg_trgm', 'exact_phrase_bonus'],
    );
  }
}

export class PostgresObjectBranch extends PostgresBranch {
  readonly name = 'object' as const;

  constructor(database: DatabaseClient) {
    super(database);
  }

  async search(query: string, plan: RetrievalExecutionPlan): Promise<BranchResult> {
    const queryTerms = normalizeRetrievalText(query).toLowerCase().split(/\s+/).filter(Boolean);
    const scopedTerms = queryTerms.filter((term) => plan.object_terms.includes(term));
    const terms = scopedTerms.length > 0 ? scopedTerms : plan.object_terms.length > 0 ? plan.object_terms : queryTerms;
    if (terms.length === 0) return this.completed(plan, '', [], 'postgres-object-v2', 'object_alias_lexical', []);
    const result = await this.database.query<CandidateRow>(`
      WITH query_terms AS (SELECT unnest($1::text[]) AS term),
      scored AS (
      SELECT e.evidence_id, e.video_id, v.object_key AS video_object_key, e.original_frame_id,
             e.start_ms, e.end_ms, f.thumbnail_object_key AS preview_object_key,
             MAX(
               (CASE WHEN o.normalized_label = q.term THEN 1.0 ELSE similarity(o.normalized_label, q.term) END)
               * (0.75 + 0.25 * o.confidence)
             ) AS rank_score,
             o.label AS matched_label
      FROM object_evidence o
      JOIN evidence e ON e.evidence_id = o.evidence_id
      JOIN videos v ON v.video_id = e.video_id
      JOIN feature_sets fs ON fs.feature_set_id = e.feature_set_id
      JOIN index_release_features irf
        ON irf.feature_set_id = fs.feature_set_id
       AND irf.dataset_version = fs.dataset_version
       AND irf.modality = fs.modality
      JOIN index_releases ir
        ON ir.index_version = irf.index_version
       AND ir.dataset_version = irf.dataset_version
      LEFT JOIN frames f ON f.video_id = e.video_id AND f.original_frame_id = e.original_frame_id
      JOIN query_terms q ON o.normalized_label = q.term OR similarity(o.normalized_label, q.term) > 0.2
      WHERE o.confidence >= $2
        AND ir.status = 'active'
        AND ir.index_version = $3
      GROUP BY e.evidence_id, e.video_id, v.object_key, e.original_frame_id,
               e.start_ms, e.end_ms, f.thumbnail_object_key, o.label
      )
      SELECT * FROM scored
      ORDER BY rank_score DESC, video_id, start_ms, evidence_id
      LIMIT $4`, [terms, plan.object_constraints.min_confidence, plan.index_version, plan.top_k_per_branch]);
    return this.completed(
      plan,
      terms.join(' '),
      result.rows,
      'postgres-object-v2',
      'object_alias_lexical',
      ['exact_canonical_label', 'pg_trgm_alias_fallback', 'confidence_quality_adjustment'],
    );
  }
}
