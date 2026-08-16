import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/common/config';
import type { DatabaseClient } from '../src/database/database.client';
import { UnavailableRetrievalBranch } from '../src/retrieval/branch';
import { PostgresObjectBranch } from '../src/retrieval/postgres-branches';
import { RetrievalService } from '../src/retrieval/retrieval.service';
import { TaskExecutorRegistry } from '../src/tasks/task-registry';
import { TextualKisExecutor } from '../src/tasks/textual-kis/textual-kis.executor';

function schema(name: string): object {
  const path = resolve(__dirname, `../../../contracts/schemas/${name}/schema.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as object;
}

describe('runtime payload contract parity', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });

  it('validates the ingestion audit record used by the database importer', () => {
    const validate = ajv.compile(schema('ingestion_record'));
    const record = {
      ingestion_id: 'ingest-aic2026-v1-videos',
      feature_set_id: null,
      artifact_id: null,
      source_artifact_uri: 'r2://aic-artifacts/canonical/videos.jsonl',
      source_checksum_sha256: 'a'.repeat(64),
      target_table: 'videos',
      dataset_version: 'aic2026-v1',
      pipeline_version: 'main-v1.0.0',
      status: 'completed',
      records_seen: 873,
      records_inserted: 873,
      records_updated: 0,
      records_skipped: 0,
      records_failed: 0,
      checkpoint: { last_video_id: 'L30_V096' },
      started_at: '2026-08-15T00:00:00Z',
      finished_at: '2026-08-15T00:10:00Z',
      errors: [],
    };
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
  });

  it('validates the actual QueryPlan emitted by RetrievalService', () => {
    const service = new RetrievalService(
      loadConfig(),
      [new UnavailableRetrievalBranch('clip'), new UnavailableRetrievalBranch('caption'), new UnavailableRetrievalBranch('object')],
      undefined as never,
    );
    const runtimePlan = service.createPlan({ query: 'hai người cầm chai bên trái', task: 'textual_kis' });
    const validate = ajv.compile(schema('query_plan'));
    expect(validate(runtimePlan), JSON.stringify(validate.errors)).toBe(true);
  });

  it('validates an actual PostgreSQL object branch result including runtime-only fields', async () => {
    const database: DatabaseClient = {
      isConfigured: true,
      health: vi.fn(async () => true),
      query: vi.fn(async () => ({ rows: [{
        evidence_id: 'object-1', video_id: 'video-1', original_frame_id: 5,
        start_ms: 100, end_ms: 101, preview_object_key: 'keyframes/video-1/5.jpg', rank_score: 0.9,
        matched_label: 'bottle',
      }] as never[], rowCount: 1 })),
    };
    const branch = new PostgresObjectBranch(database);
    const service = new RetrievalService(
      loadConfig(),
      [new UnavailableRetrievalBranch('clip'), new UnavailableRetrievalBranch('caption'), branch],
      undefined as never,
    );
    const runtimePlan = service.createPlan({ query: 'một chai nước', task: 'textual_kis' });
    const runtimeResult = await branch.search('bottle', runtimePlan);
    const validate = ajv.compile(schema('branch_result'));
    expect(validate(runtimeResult), JSON.stringify(validate.errors)).toBe(true);
  });

  it('validates the actual fused SearchResponse including fusion_trace', async () => {
    const branch = {
      name: 'caption' as const,
      async search(_query: string, plan: ReturnType<RetrievalService['createPlan']>) {
        return {
          query_id: plan.query_id, branch: 'caption' as const, status: 'completed' as const,
          query_variant: plan.original_query,
          candidates: [{
            video_id: 'v1', rank: 1, raw_score: 0.8,
            original_frame_id: 3, start_ms: 100, end_ms: 200, evidence_ids: ['caption-1'],
          }],
          elapsed_ms: 1, deadline_ms: plan.latency_budget_ms,
          index_version: plan.index_version, producer: 'test',
        };
      },
    };
    const registry = new TaskExecutorRegistry();
    registry.register(new TextualKisExecutor());
    const service = new RetrievalService(loadConfig(), [branch], registry);
    const response = await service.search({ query: 'a runner crosses the finish line', task: 'textual_kis' });
    const validate = ajv.compile(schema('search_response'));
    expect(validate(response), JSON.stringify(validate.errors)).toBe(true);
    expect(response.results[0].fusion_trace[0]).toMatchObject({ branch: 'caption', channel_rank: 1 });
  });
});
