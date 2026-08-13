import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/common/config';
import { RETRIEVAL_BRANCHES, TASK_EXECUTOR_REGISTRY, APP_CONFIG } from '../src/common/tokens';
import type { BranchResult, RetrievalExecutionPlan } from '../src/common/types';
import { RetrievalService } from '../src/retrieval/retrieval.service';
import type { RetrievalBranch } from '../src/retrieval/branch';
import { TaskExecutorRegistry } from '../src/tasks/task-registry';
import { TextualKisExecutor } from '../src/tasks/textual-kis/textual-kis.executor';
import { TrakeExecutor } from '../src/tasks/trake/trake.executor';
import { VqaExecutor } from '../src/tasks/vqa/vqa.executor';

function createRegistry() {
  const registry = new TaskExecutorRegistry();
  registry.register(new TextualKisExecutor());
  registry.register(new VqaExecutor(loadConfig()));
  registry.register(new TrakeExecutor());
  return registry;
}

function completedBranch(name: RetrievalBranch['name'], candidates: BranchResult['candidates']): RetrievalBranch {
  return {
    name,
    async search(_query: string, plan: RetrievalExecutionPlan) {
      return {
        query_id: plan.query_id,
        branch: name,
        status: 'completed',
        query_variant: plan.original_query,
        candidates,
        elapsed_ms: 1,
        deadline_ms: plan.latency_budget_ms,
        index_version: plan.index_version,
        producer: 'test-branch',
      };
    },
  };
}

describe('RetrievalService', () => {
  it('creates an all-branch plan with configurable k values', () => {
    const branches = [completedBranch('clip', [])];
    const service = new RetrievalService(loadConfig(), branches, createRegistry());

    const plan = service.createPlan({
      query: 'một người đang chạy',
      task: 'vqa',
      top_k: 20,
      retrieval: { branch_k: 50, fusion_k: 80, display_k: 10 },
    });

    expect(plan.branches).toEqual(['clip']);
    expect(plan.top_k_per_branch).toBe(50);
    expect(plan.fusion_k).toBe(80);
    expect(plan.display_k).toBe(10);
    expect(plan.language).toBe('vi');
  });

  it('splits TRAKE event lines into independent retrieval variants', () => {
    const service = new RetrievalService(loadConfig(), [completedBranch('caption', [])], createRegistry());
    const plan = service.createPlan({ query: '1. mở cửa\n2) bước vào phòng\n3. ngồi xuống', task: 'trake' });
    expect(plan.query_variants).toEqual(['mở cửa', 'bước vào phòng', 'ngồi xuống']);
  });

  it('fuses candidates and returns a frontend-compatible response', async () => {
    const branches = [
      completedBranch('clip', [{
        segment_id: 'seg-1',
        video_id: 'L21_V001',
        rank: 1,
        raw_score: 0.9,
        original_frame_id: 12,
        start_ms: 100,
        end_ms: 200,
        preview_uri: 'r2://bucket/keyframes/L21_V001/000012.jpg',
        evidence_ids: ['clip-1'],
      }]),
      completedBranch('object', [{
        segment_id: 'seg-1',
        video_id: 'L21_V001',
        rank: 2,
        raw_score: 0.8,
        original_frame_id: 12,
        start_ms: 100,
        end_ms: 200,
        evidence_ids: ['object-1'],
      }]),
    ];
    const service = new RetrievalService(loadConfig(), branches, createRegistry());

    const response = await service.search({ query: 'what is happening?', task: 'vqa', top_k: 10 });

    expect(response.results).toHaveLength(1);
    expect(response.results[0].video_id).toBe('L21_V001');
    expect(response.results[0].evidence_ids).toEqual(['clip-1', 'object-1']);
    expect(response.results[0].matched_modalities).toEqual(['embedding', 'object']);
    expect(response.warnings[0]).toContain('manual curation');
  });

  it('isolates branch and persistence failures in a degraded response', async () => {
    const failingBranch: RetrievalBranch = {
      name: 'audio',
      async search() { throw new Error('audio index down'); },
    };
    const store = {
      saveRun: async () => { throw new Error('database busy'); },
      listCandidates: async () => { throw new Error('unused'); },
      saveSelection: async () => { throw new Error('unused'); },
      getLatestSelection: async () => null,
    };
    const service = new RetrievalService(loadConfig(), [failingBranch], createRegistry(), store);

    const response = await service.search({ query: 'sound', task: 'textual_kis' });

    expect(response.degraded).toBe(true);
    expect(response.unavailable_branches).toEqual(['audio']);
    expect(response.warnings).toContain('retrieval_persistence_failed');
  });

  it('signs R2 previews and hydrates evidence for the workbench', async () => {
    const branch = completedBranch('caption', [{
      segment_id: 's', video_id: 'v', rank: 1, raw_score: 1, original_frame_id: 1,
      start_ms: 10, end_ms: 20, preview_uri: 'r2://media/keyframes/v/1.jpg', evidence_ids: ['e-1'],
    }]);
    const evidenceRepository = { findByIds: async () => new Map([['e-1', {
      evidence_id: 'e-1', type: 'caption', start_ms: 10, end_ms: 20, snippet: 'bike', producer: 'captioner',
    }]]) };
    const storage = { isConfigured: true, signReadUrl: async (key: string) => `https://signed/${key}`, health: async () => true };
    const service = new RetrievalService(loadConfig(), [branch], createRegistry(), undefined, evidenceRepository, storage);
    const response = await service.search({ query: 'bike', task: 'textual_kis' });
    expect(response.results[0].preview_uri).toBe('https://signed/keyframes/v/1.jpg');
    expect(response.results[0].evidence[0]).toMatchObject({ snippet: 'bike' });
  });
});
