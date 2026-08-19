import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '../src/database/database.client';
import { PostgresRetrievalStore, UnavailableRetrievalStore } from '../src/retrieval/retrieval.store';
import type { RetrievalExecutionPlan } from '../src/common/types';

function database(rows: never[] = []): DatabaseClient {
  return { isConfigured: true, health: vi.fn(async () => true), query: vi.fn(async () => ({ rows, rowCount: rows.length })) };
}

describe('PostgresRetrievalStore', () => {
  it('persists a retrieval run and candidate snapshot with JSON parameters', async () => {
    const db = database();
    const store = new PostgresRetrievalStore(db);
    const plan = {
      query_id: 'q-1', task: 'vqa', original_query: 'question', index_version: 'v1',
    } as RetrievalExecutionPlan;
    await store.saveRun({ query: 'question', task: 'vqa' }, plan, [{
      video_id: 'v', original_frame_id: 1, start_ms: 10, end_ms: 11,
      score: 0.5, evidence_ids: ['e'], matched_modalities: ['caption'], fusion_trace: [],
    }]);
    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain('jsonb_array_elements');
    expect(params?.[3]).toBe('question');
    expect(params?.[7]).toContain('"original_frame_id":1');
  });

  it('persists a non-empty label for image-only frame queries', async () => {
    const db = database();
    const store = new PostgresRetrievalStore(db);
    const plan = {
      query_id: 'q-frame', task: 'textual_kis', original_query: '[frame image query]', index_version: 'v1',
    } as RetrievalExecutionPlan;

    await store.saveRun({
      query: '',
      task: 'textual_kis',
      frame_query: { video_id: 'video-01', original_frame_id: 385 },
    }, plan, []);

    const [, params] = vi.mocked(db.query).mock.calls[0];
    expect(params?.[3]).toBe('[frame image query] video-01 frame 385');
  });

  it('maps paginated candidates and selection revisions', async () => {
    const db = database([{
      total_count: '1', rank: 1, video_id: 'v', original_frame_id: 2,
      start_ms: 10, end_ms: 20, preview_uri: null, score: '0.5', evidence_ids: ['e'], matched_modalities: ['ocr'],
      fusion_trace: [{ branch: 'ocr', channel_rank: 1, weight: 1, contribution: 0.1, evidence_ids: ['e'] }],
    }] as never[]);
    const store = new PostgresRetrievalStore(db);
    const page = await store.listCandidates('q', 10, 0);
    expect(page).toMatchObject({ total: 1, candidates: [{ rank: 1, score: 0.5, fusion_trace: [{ branch: 'ocr' }] }] });

    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ selection_id: 1 }] as never[], rowCount: 1 });
    await expect(store.saveSelection('q', 'textual_kis', [{ video_id: 'v', frame_id: 1 }], 'ok'))
      .resolves.toEqual({ selection_id: 1 });
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] as never[], rowCount: 0 });
    await expect(store.getLatestSelection('missing')).resolves.toBeNull();
  });

  it('keeps search usable but disables manual persistence without Neon', async () => {
    const store = new UnavailableRetrievalStore();
    await expect(store.saveRun()).resolves.toBeUndefined();
    await expect(store.listCandidates('q', 10, 0)).rejects.toThrow('DATABASE_URL');
    await expect(store.saveSelection('q', 'vqa', [])).rejects.toThrow('DATABASE_URL');
    await expect(store.getLatestSelection('q')).rejects.toThrow('DATABASE_URL');
  });
});
