import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '../src/database/database.client';
import type { QueryEmbeddingProvider } from '../src/compute/model-ports';
import { PostgresClipBranch } from '../src/retrieval/postgres-clip.branch';
import type { RetrievalExecutionPlan } from '../src/common/types';

describe('PostgresClipBranch', () => {
  it('delegates text encoding and performs parameterized cosine search', async () => {
    const database: DatabaseClient = {
      isConfigured: true,
      health: vi.fn(async () => true),
      query: vi.fn(async () => ({ rows: [{
        evidence_id: 'clip-1', video_id: 'video-1',
        original_frame_id: 7, start_ms: 200, end_ms: 201,
        preview_object_key: 'keyframes/video-1/7.jpg', video_object_key: 'videos/video-1.mp4', rank_score: 0.95,
      }] as never[], rowCount: 1 })),
    };
    const encoder: QueryEmbeddingProvider = {
      isConfigured: true,
      dimensions: 1024,
      embedText: vi.fn(async () => Array.from({ length: 1024 }, () => 0.1)),
    };
    const branch = new PostgresClipBranch(database, encoder);
    const plan = {
      query_id: 'q', task: 'textual_kis', language: 'en', original_query: 'a bicycle',
      query_variants: ['a bicycle'], concepts: ['bicycle'], query_atoms: [], negative_concepts: [],
      text_constraints: [], audio_concepts: [], object_terms: ['bicycle'],
      object_constraints: { class_filters: ['bicycle'], excluded_classes: [], min_confidence: 0.25, counts: {}, spatial: [] },
      query_views: { clip: 'a bicycle' }, channel_weights: { clip: 1 }, temporal_relations: [],
      target_granularities: ['frame'], branches: ['clip'], top_k_per_branch: 10, fusion_k: 10,
      display_k: 10, rrf_k: 60, latency_budget_ms: 5000, fallback_policy: 'none', planner_version: 'test',
      fusion: 'rrf', index_version: 'v1',
      hard_filters: {}, transformations: ['unicode_nfkc'],
    } satisfies RetrievalExecutionPlan;

    const result = await branch.search('a bicycle', plan);

    expect(encoder.embedText).toHaveBeenCalledWith('a bicycle');
    expect(result.candidates[0].raw_score).toBe(0.95);
    expect(result.candidates[0].video_object_key).toBe('videos/video-1.mp4');
    const [sql, parameters] = vi.mocked(database.query).mock.calls[0];
    expect(sql).toContain('<=> $1::vector');
    expect(sql).toContain("ir.status = 'active'");
    expect(parameters).toEqual([expect.any(String), 1024, 'v1', 10]);
  });

  it('filters active index rows before applying the vector top-k limit', async () => {
    const database: DatabaseClient = {
      isConfigured: true,
      health: vi.fn(async () => true),
      query: vi.fn(async () => ({ rows: [] as never[], rowCount: 0 })),
    };
    const encoder: QueryEmbeddingProvider = {
      isConfigured: true,
      dimensions: 1024,
      embedText: vi.fn(async () => Array.from({ length: 1024 }, () => 0.1)),
    };
    const branch = new PostgresClipBranch(database, encoder);
    const plan = {
      query_id: 'q', task: 'textual_kis', language: 'en', original_query: 'a bicycle',
      query_variants: ['a bicycle'], concepts: ['bicycle'], query_atoms: [], negative_concepts: [],
      text_constraints: [], audio_concepts: [], object_terms: ['bicycle'],
      object_constraints: { class_filters: ['bicycle'], excluded_classes: [], min_confidence: 0.25, counts: {}, spatial: [] },
      query_views: { clip: 'a bicycle' }, channel_weights: { clip: 1 }, temporal_relations: [],
      target_granularities: ['frame'], branches: ['clip'], top_k_per_branch: 10, fusion_k: 10,
      display_k: 10, rrf_k: 60, latency_budget_ms: 5000, fallback_policy: 'none', planner_version: 'test',
      fusion: 'rrf', index_version: 'v1', hard_filters: {}, transformations: [],
    } satisfies RetrievalExecutionPlan;

    await branch.search('a bicycle', plan);

    const [sql] = vi.mocked(database.query).mock.calls[0];
    const cteStart = sql.indexOf('WITH top_clips AS (');
    const outerSelect = sql.indexOf('SELECT e.evidence_id', cteStart);
    expect(cteStart).toBeGreaterThanOrEqual(0);
    expect(outerSelect).toBeGreaterThan(cteStart);

    const topClipsSql = sql.slice(cteStart, outerSelect);
    expect(topClipsSql).toContain("ir.status = 'active'");
    expect(topClipsSql).toContain('ir.index_version = $3');
    expect(topClipsSql).toMatch(/ORDER BY c\.embedding <=> \$1::vector\s+LIMIT \$4/);
  });

  it('uses a supplied frame vector without invoking text encoding', async () => {
    const database: DatabaseClient = {
      isConfigured: true,
      health: vi.fn(async () => true),
      query: vi.fn(async () => ({ rows: [] as never[], rowCount: 0 })),
    };
    const encoder: QueryEmbeddingProvider = {
      isConfigured: true,
      dimensions: 2,
      embedText: vi.fn(async () => [0.1, 0.2]),
    };
    const branch = new PostgresClipBranch(database, encoder, [0.3, 0.4]);
    const plan = {
      query_id: 'q', task: 'textual_kis', language: 'en', original_query: '[frame image query]',
      query_variants: ['[frame image query]'], concepts: [], query_atoms: [], negative_concepts: [],
      text_constraints: [], audio_concepts: [], object_terms: [],
      object_constraints: { class_filters: [], excluded_classes: [], min_confidence: 0.25, counts: {}, spatial: [] },
      query_views: { clip: '[frame image query]' }, channel_weights: { clip: 1 }, temporal_relations: [],
      target_granularities: ['frame'], branches: ['clip'], top_k_per_branch: 10, fusion_k: 10,
      display_k: 10, rrf_k: 60, latency_budget_ms: 5000, fallback_policy: 'none', planner_version: 'test',
      fusion: 'rrf', index_version: 'v1', hard_filters: {}, transformations: [],
    } satisfies RetrievalExecutionPlan;

    await branch.search('[frame image query]', plan);

    expect(encoder.embedText).not.toHaveBeenCalled();
    expect(vi.mocked(database.query).mock.calls[0][1]).toEqual([expect.any(String), 2, 'v1', 10]);
  });
});
