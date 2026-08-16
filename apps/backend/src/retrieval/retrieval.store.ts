import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { QueryResultRow } from 'pg';

import type { DatabaseClient } from '../database/database.client';
import type { FusedCandidate, RetrievalExecutionPlan, SearchRequest, TaskType } from '../common/types';

export interface CandidatePage {
  readonly query_id: string;
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly candidates: readonly (FusedCandidate & { readonly rank: number })[];
}

export interface RetrievalStore {
  saveRun(request: SearchRequest, plan: RetrievalExecutionPlan, candidates: readonly FusedCandidate[]): Promise<void>;
  listCandidates(queryId: string, limit: number, offset: number): Promise<CandidatePage>;
  saveSelection(queryId: string, task: TaskType, answers: readonly Record<string, unknown>[], note?: string): Promise<unknown>;
  getLatestSelection(queryId: string): Promise<unknown>;
}

export class UnavailableRetrievalStore implements RetrievalStore {
  async saveRun(_request?: SearchRequest, _plan?: RetrievalExecutionPlan, _candidates?: readonly FusedCandidate[]): Promise<void> {}
  async listCandidates(_queryId: string, _limit: number, _offset: number): Promise<CandidatePage> { throw new ServiceUnavailableException('DATABASE_URL is not configured'); }
  async saveSelection(_queryId: string, _task: TaskType, _answers: readonly Record<string, unknown>[], _note?: string): Promise<unknown> { throw new ServiceUnavailableException('DATABASE_URL is not configured'); }
  async getLatestSelection(_queryId: string): Promise<unknown> { throw new ServiceUnavailableException('DATABASE_URL is not configured'); }
}

interface CandidateRow extends QueryResultRow {
  readonly total_count: number | string;
  readonly rank: number;
  readonly video_id: string;
  readonly original_frame_id: number | null;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly preview_uri: string | null;
  readonly score: number | string;
  readonly evidence_ids: string[];
  readonly matched_modalities: string[];
  readonly fusion_trace: FusedCandidate['fusion_trace'];
}

export class PostgresRetrievalStore implements RetrievalStore {
  constructor(private readonly database: DatabaseClient, private readonly datasetVersion = 'local') {}

  async saveRun(request: SearchRequest, plan: RetrievalExecutionPlan, candidates: readonly FusedCandidate[]): Promise<void> {
    await this.database.query(`
      WITH inserted_run AS (
        INSERT INTO retrieval_runs (query_id, session_id, task, query_text, plan, dataset_version, index_version)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
        ON CONFLICT (query_id) DO NOTHING
        RETURNING query_id
      )
      INSERT INTO retrieval_candidates
        (query_id, rank, video_id, original_frame_id, start_ms, end_ms, preview_uri, score, evidence_ids, matched_modalities, fusion_trace)
      SELECT $1, candidate.ordinality::integer, candidate.value->>'video_id',
             NULLIF(candidate.value->>'original_frame_id', '')::integer,
             (candidate.value->>'start_ms')::integer, (candidate.value->>'end_ms')::integer,
             candidate.value->>'preview_uri', (candidate.value->>'score')::double precision,
             ARRAY(SELECT jsonb_array_elements_text(candidate.value->'evidence_ids')),
             ARRAY(SELECT jsonb_array_elements_text(candidate.value->'matched_modalities')),
             COALESCE(candidate.value->'fusion_trace', '[]'::jsonb)
      FROM jsonb_array_elements($8::jsonb) WITH ORDINALITY AS candidate(value, ordinality)
      CROSS JOIN inserted_run
      ON CONFLICT (query_id, rank) DO NOTHING`, [
        plan.query_id, request.session_id ?? null, request.task, request.query, JSON.stringify(plan),
        this.datasetVersion, plan.index_version, JSON.stringify(candidates),
      ]);
  }

  async listCandidates(queryId: string, limit: number, offset: number): Promise<CandidatePage> {
    const result = await this.database.query<CandidateRow>(`
      SELECT COUNT(*) OVER() AS total_count, rank, video_id, original_frame_id,
             start_ms, end_ms, preview_uri, score, evidence_ids, matched_modalities, fusion_trace
      FROM retrieval_candidates WHERE query_id = $1 ORDER BY rank LIMIT $2 OFFSET $3`,
      [queryId, limit, offset]);
    return {
      query_id: queryId,
      total: Number(result.rows[0]?.total_count ?? 0),
      limit,
      offset,
      candidates: result.rows.map((row) => ({
        rank: row.rank, video_id: row.video_id,
        original_frame_id: row.original_frame_id, start_ms: row.start_ms, end_ms: row.end_ms,
        preview_uri: row.preview_uri ?? undefined, score: Number(row.score),
        evidence_ids: row.evidence_ids, matched_modalities: row.matched_modalities, fusion_trace: row.fusion_trace,
      })),
    };
  }

  async saveSelection(queryId: string, task: TaskType, answers: readonly Record<string, unknown>[], note?: string): Promise<unknown> {
    const result = await this.database.query(`
      WITH locked AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtext($1))
      ), valid_run AS MATERIALIZED (
        SELECT r.query_id FROM retrieval_runs r, locked
        WHERE r.query_id = $1 AND r.task = $2
      ), next_revision AS (
        SELECT COALESCE((SELECT MAX(revision) FROM manual_selections WHERE query_id = $1), 0) + 1 AS value
        FROM valid_run
      )
      INSERT INTO manual_selections (query_id, revision, task, answers, note)
      SELECT $1, value, $2, $3::jsonb, $4 FROM next_revision
      RETURNING selection_id, query_id, revision, task, answers, note, created_at`,
      [queryId, task, JSON.stringify(answers), note ?? null]);
    if (!result.rows[0]) throw new BadRequestException('query does not exist or task does not match the retrieval run');
    return result.rows[0];
  }

  async getLatestSelection(queryId: string): Promise<unknown> {
    const result = await this.database.query(`
      SELECT selection_id, query_id, revision, task, answers, note, created_at
      FROM manual_selections WHERE query_id = $1 ORDER BY revision DESC LIMIT 1`, [queryId]);
    return result.rows[0] ?? null;
  }
}
