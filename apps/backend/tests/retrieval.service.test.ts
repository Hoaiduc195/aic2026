import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/common/config';
import { RETRIEVAL_BRANCHES, TASK_EXECUTOR_REGISTRY, APP_CONFIG } from '../src/common/tokens';
import type { BranchResult, RetrievalExecutionPlan } from '../src/common/types';
import type { EmbeddingService } from '../src/embedding_services/embedding.service';
import type { MediaService } from '../src/media/media.service';
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
  it('uses a bounded default branch candidate limit', () => {
    const service = new RetrievalService(loadConfig(), [completedBranch('object', [])], createRegistry());

    const plan = service.createPlan({ query: 'person', task: 'textual_kis', top_k: 20 });

    expect(plan.top_k_per_branch).toBe(100);
  });

  it('creates an all-branch plan with configurable k values', () => {
    const branches = [completedBranch('clip', [])];
    const service = new RetrievalService(loadConfig(), branches, createRegistry());

    const plan = service.createPlan({
      query: 'một người đang chạy',
      task: 'vqa',
      top_k: 20,
      retrieval: {
        branch_k: 50,
        fusion_k: 80,
        display_k: 10,
        rrf_k: 30,
        channel_weights: { clip: 1.5 },
      },
    });

    expect(plan.branches).toEqual(['clip']);
    expect(plan.top_k_per_branch).toBe(50);
    expect(plan.fusion_k).toBe(80);
    expect(plan.display_k).toBe(10);
    expect(plan.rrf_k).toBe(30);
    expect(plan.channel_weights.clip).toBe(1.5);
    expect(plan.language).toBe('vi');
  });

  it('prefers an indexed exact-frame vector and keeps the query image-only', async () => {
    const imageBranch = completedBranch('clip', []);
    const embeddingService = {
      findIndexedFrameEmbedding: vi.fn(async () => [0.1, 0.2]),
      embedImage: vi.fn(),
      resolveBranches: vi.fn((_branches, _request, queryEmbedding) => {
        expect(queryEmbedding).toEqual([0.1, 0.2]);
        return [imageBranch];
      }),
    } as unknown as EmbeddingService;
    const mediaService = {
      getFrameThumbnail: vi.fn(),
    } as unknown as MediaService;
    const service = new RetrievalService(
      loadConfig(), [imageBranch], createRegistry(), undefined, undefined, undefined, embeddingService, undefined, mediaService,
    );

    const response = await service.search({
      query: '',
      task: 'textual_kis',
      frame_query: { video_id: 'video_01', original_frame_id: 385 },
    });

    expect(response.query_mode).toBe('frame_image');
    expect(embeddingService.findIndexedFrameEmbedding).toHaveBeenCalledWith(
      'video_01', 385, loadConfig().indexVersion,
    );
    expect(embeddingService.embedImage).not.toHaveBeenCalled();
    expect(mediaService.getFrameThumbnail).not.toHaveBeenCalled();
  });

  it('decodes and encodes the exact frame only when the vector is not indexed', async () => {
    const imageBranch = completedBranch('clip', []);
    const embeddingService = {
      findIndexedFrameEmbedding: vi.fn(async () => null),
      embedImage: vi.fn(async () => [0.3, 0.4]),
      resolveBranches: vi.fn(() => [imageBranch]),
    } as unknown as EmbeddingService;
    const mediaService = {
      getFrameThumbnail: vi.fn(async () => ({ mime_type: 'image/jpeg', bytes: Buffer.from('frame') })),
    } as unknown as MediaService;
    const service = new RetrievalService(
      loadConfig(), [imageBranch], createRegistry(), undefined, undefined, undefined, embeddingService, undefined, mediaService,
    );

    await service.search({
      query: '',
      task: 'textual_kis',
      frame_query: { video_id: 'video_02', original_frame_id: 17 },
    });

    expect(mediaService.getFrameThumbnail).toHaveBeenCalledWith('video_02', 17);
    expect(embeddingService.embedImage).toHaveBeenCalledWith(Buffer.from('frame'), 'image/jpeg', expect.anything());
  });

  it('uses only the TRAKE main query as the retrieval variant', () => {
    const service = new RetrievalService(loadConfig(), [completedBranch('caption', [])], createRegistry());
    const plan = service.createPlan({
      query: 'Một người đi qua cửa hàng\n1. Người bước vào cửa hàng\n2. Người rời khỏi cửa hàng',
      task: 'trake',
    });
    expect(plan.original_query).toBe('Một người đi qua cửa hàng');
    expect(plan.query_variants).toEqual(['Một người đi qua cửa hàng']);
    expect(plan.temporal_relations).toEqual([]);
  });

  it('returns main-query TRAKE candidates without event alignment', async () => {
    const branch = completedBranch('caption', [
      {
        video_id: 'video-1', rank: 1, raw_score: 0.9, original_frame_id: 10,
        start_ms: 100, end_ms: 101, evidence_ids: [],
      },
      {
        video_id: 'video-1', rank: 2, raw_score: 0.8, original_frame_id: 20,
        start_ms: 2_000, end_ms: 2_001, evidence_ids: [],
      },
    ]);
    const service = new RetrievalService(loadConfig(), [branch], createRegistry());

    const response = await service.search({
      query: '1. open the door\n2. walk into the room',
      task: 'trake',
      retrieval: { near_frame_window_ms: 500 },
    });

    expect(response.task).toBe('trake');
    expect(response.degraded).toBe(false);
    expect(response.results.map((result) => result.original_frame_id)).toEqual([10, 20]);
  });

  it('fuses candidates and returns a frontend-compatible response', async () => {
    const branches = [
      completedBranch('clip', [{
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

    const response = await service.search({ query: 'a person holding a bottle', task: 'vqa', top_k: 10 });

    expect(response.results).toHaveLength(1);
    expect(response.results[0].video_id).toBe('L21_V001');
    expect(response.results[0].evidence_ids).toEqual(['clip-1', 'object-1']);
    expect(response.results[0].matched_modalities).toEqual(['embedding', 'object']);
    expect(response.warnings[0]).toContain('manual curation');
  });

  it('filters nearby frames per video after fusion while keeping other videos', async () => {
    const branch = completedBranch('caption', [
      {
        video_id: 'video-1', rank: 1, raw_score: 0.99, original_frame_id: 100, timestamp_ms: 1_000,
        start_ms: 1_000, end_ms: 1_001, evidence_ids: ['e-100'],
      },
      {
        video_id: 'video-1', rank: 2, raw_score: 0.98, original_frame_id: 110, timestamp_ms: 1_400,
        start_ms: 1_400, end_ms: 1_401, evidence_ids: ['e-110'],
      },
      {
        video_id: 'video-2', rank: 3, raw_score: 0.97, original_frame_id: 200, timestamp_ms: 1_100,
        start_ms: 1_100, end_ms: 1_101, evidence_ids: ['e-200'],
      },
    ]);
    const service = new RetrievalService(loadConfig(), [branch], createRegistry());

    const response = await service.search({
      query: 'a person walking', task: 'textual_kis', top_k: 10,
      retrieval: { near_frame_window_ms: 500 },
    });

    expect(response.results.map((result) => [result.video_id, result.original_frame_id])).toEqual([
      ['video-1', 100], ['video-2', 200],
    ]);
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

  it('enforces the branch deadline and returns a recoverable timeout', async () => {
    let receivedSignal: AbortSignal | undefined;
    const slowBranch: RetrievalBranch = {
      name: 'caption',
      async search(_query, plan, signal) {
        receivedSignal = signal;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 100);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        return {
          query_id: plan.query_id, branch: 'caption', status: 'completed', query_variant: plan.original_query,
          candidates: [], elapsed_ms: 100, deadline_ms: plan.latency_budget_ms,
          index_version: plan.index_version, producer: 'slow-test',
        };
      },
    };
    const service = new RetrievalService(loadConfig(), [slowBranch], createRegistry());
    const response = await service.search({
      query: 'a person running', task: 'textual_kis', retrieval: { latency_budget_ms: 10 },
    });
    expect(response.degraded).toBe(true);
    expect(response.unavailable_branches).toEqual(['caption']);
    expect(response.timing).toMatchObject({ branch_status: { caption: 'timed_out' } });
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('signs R2 previews and hydrates evidence for the workbench', async () => {
    const branch = completedBranch('caption', [{
      video_id: 'v', rank: 1, raw_score: 1, original_frame_id: 1,
      start_ms: 10, end_ms: 20, preview_uri: 'r2://media/keyframes/v/1.jpg', evidence_ids: ['e-1'],
    }]);
    const evidenceRepository = { findByIds: async () => new Map([['e-1', {
      evidence_id: 'e-1', type: 'caption', start_ms: 10, end_ms: 20, snippet: 'bike', producer: 'captioner',
    }]]) };
    const store = {
      saveRun: vi.fn(async () => undefined),
      listCandidates: vi.fn(),
      saveSelection: vi.fn(),
      getLatestSelection: vi.fn(),
    };
    const storage = { isConfigured: true, signReadUrl: async (key: string) => `https://signed/${key}`, health: async () => true };
    const service = new RetrievalService(loadConfig(), [branch], createRegistry(), store, evidenceRepository, storage);
    const response = await service.search({ query: 'bike', task: 'textual_kis' });
    expect(response.results[0].preview_uri).toBe('https://signed/keyframes/v/1.jpg');
    expect(response.results[0].evidence[0]).toMatchObject({ snippet: 'bike' });
    expect(store.saveRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [expect.objectContaining({ preview_uri: 'r2://media/keyframes/v/1.jpg' })],
    );
  });

  it('signs the video object key when a keyframe preview is unavailable', async () => {
    const branch = completedBranch('caption', [{
      video_id: 'v', rank: 1, raw_score: 1, original_frame_id: null,
      start_ms: 10, end_ms: 20, video_object_key: 'videos/v.mp4', evidence_ids: ['e-1'],
    }]);
    const store = {
      saveRun: vi.fn(async () => undefined),
      listCandidates: vi.fn(),
      saveSelection: vi.fn(),
      getLatestSelection: vi.fn(),
    };
    const storage = { isConfigured: true, signReadUrl: vi.fn(async (key: string) => `https://signed/${key}`), health: async () => true };
    const service = new RetrievalService(loadConfig(), [branch], createRegistry(), store, undefined, storage);

    const response = await service.search({ query: 'bike', task: 'textual_kis' });

    expect(response.results[0].preview_uri).toBe('https://signed/videos/v.mp4');
    expect(storage.signReadUrl).toHaveBeenCalledWith('videos/v.mp4');
    expect(store.saveRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [expect.objectContaining({ preview_uri: 'r2://media/videos/v.mp4' })],
    );
  });
});
