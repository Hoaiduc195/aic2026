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
        evidence_id: 'clip-1', segment_id: 'seg-1', video_id: 'video-1',
        original_frame_id: 7, start_ms: 200, end_ms: 201,
        preview_object_key: 'keyframes/video-1/7.jpg', rank_score: 0.95,
      }] as never[], rowCount: 1 })),
    };
    const encoder: QueryEmbeddingProvider = {
      isConfigured: true,
      dimensions: 512,
      embedText: vi.fn(async () => Array.from({ length: 512 }, () => 0.1)),
    };
    const branch = new PostgresClipBranch(database, encoder);
    const plan = {
      query_id: 'q', task: 'textual_kis', language: 'en', original_query: 'a bicycle',
      query_variants: ['a bicycle'], concepts: ['bicycle'], query_atoms: [], negative_concepts: [],
      text_constraints: [], audio_concepts: [], object_terms: ['bicycle'],
      object_constraints: { class_filters: ['bicycle'], excluded_classes: [], min_confidence: 0.25, counts: {}, spatial: [] },
      query_views: { clip: 'a bicycle' }, channel_weights: { clip: 1 }, temporal_relations: [],
      target_granularities: ['frame'], branches: ['clip'], top_k_per_branch: 10, fusion_k: 10,
      display_k: 10, latency_budget_ms: 5000, fallback_policy: 'none', planner_version: 'test',
      fusion: 'rrf', index_version: 'v1',
      hard_filters: {}, transformations: ['unicode_nfkc'],
    } satisfies RetrievalExecutionPlan;

    const result = await branch.search('a bicycle', plan);

    expect(encoder.embedText).toHaveBeenCalledWith('a bicycle');
    expect(result.candidates[0].raw_score).toBe(0.95);
    const [sql, parameters] = vi.mocked(database.query).mock.calls[0];
    expect(sql).toContain('<=> $1::vector');
    expect(parameters?.[1]).toBe(10);
  });
});
