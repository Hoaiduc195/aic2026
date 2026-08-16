import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '../src/database/database.client';
import { PostgresObjectBranch, PostgresTextBranch } from '../src/retrieval/postgres-branches';
import type { RetrievalExecutionPlan } from '../src/common/types';

const plan: RetrievalExecutionPlan = {
  query_id: 'query-1',
  task: 'textual_kis',
  language: 'vi',
  original_query: 'người đi xe đạp',
  query_variants: ['người đi xe đạp'],
  concepts: [],
  query_atoms: [],
  negative_concepts: [],
  text_constraints: [],
  audio_concepts: [],
  object_terms: ['person', 'bicycle'],
  object_constraints: { class_filters: ['person', 'bicycle'], excluded_classes: [], min_confidence: 0.25, counts: {}, spatial: [] },
  query_views: { caption: 'người đi xe đạp', object: 'person bicycle' },
  channel_weights: { caption: 1, object: 1.2 },
  temporal_relations: [],
  target_granularities: ['frame'],
  branches: ['caption'],
  top_k_per_branch: 20,
  fusion_k: 20,
  display_k: 10,
  latency_budget_ms: 5000,
  fallback_policy: 'none',
  planner_version: 'test',
  fusion: 'rrf',
  index_version: 'index-1',
  hard_filters: {},
  transformations: ['unicode_nfkc'],
};

function database(rows: readonly unknown[]): DatabaseClient {
  return {
    isConfigured: true,
    query: vi.fn(async () => ({ rows: [...rows] as never[], rowCount: rows.length })),
    health: vi.fn(async () => true),
  };
}

describe('Postgres retrieval branches', () => {
  it('uses parameterized FTS and maps caption evidence to a candidate', async () => {
    const db = database([{
      evidence_id: 'caption-1', video_id: 'video-1',
      original_frame_id: 42, start_ms: 1000, end_ms: 2000,
      preview_object_key: 'keyframes/video-1/000042.jpg', video_object_key: 'videos/video-1.mp4', rank_score: 0.8,
    }]);
    const branch = new PostgresTextBranch('caption', 'caption', db);

    const result = await branch.search("người ' đi xe", plan);

    expect(result.status).toBe('completed');
    expect(result.candidates[0]).toMatchObject({
      video_id: 'video-1', original_frame_id: 42, evidence_ids: ['caption-1'], rank: 1,
      video_object_key: 'videos/video-1.mp4',
    });
    const [sql, parameters] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain('websearch_to_tsquery');
    expect(sql).toContain("ir.status = 'active'");
    expect(sql).not.toContain("người ' đi xe");
    expect(parameters).toEqual(["người ' đi xe", 'caption', 'index-1', 20]);
  });

  it('returns exact object matches without running fuzzy matching', async () => {
    const db = database([{
      evidence_id: 'object-1', video_id: 'video-1',
      original_frame_id: 5, start_ms: 100, end_ms: 101,
      preview_object_key: null, video_object_key: 'videos/video-1.mp4', rank_score: 0.7, matched_label: 'bicycle',
    }]);
    const branch = new PostgresObjectBranch(db);

    const result = await branch.search('bicycle', { ...plan, branches: ['object'] }, new AbortController().signal);

    expect(result.candidates[0].matched_terms).toEqual(['bicycle']);
    expect(result.candidates[0].video_object_key).toBe('videos/video-1.mp4');
    expect(db.query).toHaveBeenCalledOnce();
    const [sql, parameters, options] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain('matched_objects AS MATERIALIZED');
    expect(sql).toContain('o.normalized_label = ANY($1::text[])');
    expect(sql).not.toContain('similarity');
    expect(sql).toContain("ir.status = 'active'");
    expect(parameters).toEqual([['bicycle'], 0.25, 'index-1', 20]);
    expect(options).toMatchObject({ statementTimeoutMs: 5000 });
  });

  it('uses fuzzy object matching only after exact lookup returns no rows', async () => {
    const db = database([]);
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        evidence_id: 'object-2', video_id: 'video-2',
        original_frame_id: 7, start_ms: 140, end_ms: 141,
        preview_object_key: null, video_object_key: 'videos/video-2.mp4', rank_score: 0.6, matched_label: 'bicycles',
      }] as never[], rowCount: 1 });
    const branch = new PostgresObjectBranch(db);

    const result = await branch.search('bicycle', { ...plan, branches: ['object'] });

    expect(result.candidates[0].matched_terms).toEqual(['bicycles']);
    expect(db.query).toHaveBeenCalledTimes(2);
    const [exactSql] = vi.mocked(db.query).mock.calls[0];
    const [fuzzySql, parameters, options] = vi.mocked(db.query).mock.calls[1];
    expect(exactSql).not.toContain('similarity');
    expect(fuzzySql).toContain('similarity');
    expect(parameters).toEqual([['bicycle'], 0.25, 'index-1', 20]);
    expect(options).toMatchObject({ statementTimeoutMs: 5000 });
  });
});
