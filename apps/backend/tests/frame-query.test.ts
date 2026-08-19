import { describe, expect, it, vi } from 'vitest';

import { parseSearchRequest } from '../src/common/request-validation';
import type { DatabaseClient } from '../src/database/database.client';
import { EmbeddingService } from '../src/embedding_services/embedding.service';
import { buildDeterministicPlan } from '../src/retrieval/query-planner';
import type { QueryEmbeddingProvider } from '../src/compute/model-ports';

describe('frame image query contracts', () => {
  it('accepts an empty text query when an exact frame identity is supplied', () => {
    const request = parseSearchRequest({
      query: '',
      task: 'textual_kis',
      frame_query: { video_id: 'video_01', original_frame_id: 385 },
    });

    expect(request).toMatchObject({
      query: '',
      frame_query: { video_id: 'video_01', original_frame_id: 385 },
    });
  });

  it('rejects an empty query without a valid frame identity', () => {
    expect(() => parseSearchRequest({ query: '', task: 'textual_kis' })).toThrow(
      'query must contain 1-2000 characters unless frame_query is supplied',
    );
    expect(() => parseSearchRequest({
      query: '',
      task: 'textual_kis',
      frame_query: { video_id: '../private', original_frame_id: 1 },
    })).toThrow('frame_query.video_id');
  });

  it('creates a clip-only plan for an image query', () => {
    const request = parseSearchRequest({
      query: '',
      task: 'textual_kis',
      frame_query: { video_id: 'video_01', original_frame_id: 385 },
    });

    const plan = buildDeterministicPlan(
      request,
      'query_01',
      'idx-v1',
      [
        { name: 'clip', available: true },
        { name: 'caption', available: true },
        { name: 'object', available: true },
      ],
      { branchK: 100, fusionK: 100, displayK: 20, latencyBudgetMs: 5000, rrfK: 60 },
    );

    expect(plan).toMatchObject({
      query_mode: 'frame_image',
      frame_query: { video_id: 'video_01', original_frame_id: 385 },
      branches: ['clip'],
    });
    expect(plan.original_query).not.toBe('');
    expect(plan.query_variants).toHaveLength(1);
  });

  it('looks up an indexed vector by video and exact frame identity', async () => {
    const database: DatabaseClient = {
      isConfigured: true,
      health: vi.fn(async () => true),
      query: vi.fn(async () => ({ rows: [{ embedding: '[0.1,0.2]' }] as never[], rowCount: 1 })),
    };
    const provider: QueryEmbeddingProvider = {
      isConfigured: true,
      dimensions: 2,
      embedText: vi.fn(async () => [0.1, 0.2]),
    };
    const service = new EmbeddingService(database, provider);

    await expect(service.findIndexedFrameEmbedding('video_01', 385, 'idx-v1')).resolves.toEqual([0.1, 0.2]);
    const [sql, parameters] = vi.mocked(database.query).mock.calls[0];
    expect(sql).toContain('e.original_frame_id = $2');
    expect(sql).toContain('ir.index_version = $3');
    expect(parameters).toEqual(['video_01', 385, 'idx-v1', 2]);
  });
});
