import { describe, expect, it } from 'vitest';

import { SearchLoopService } from '../src/search-loop.js';
import { SearchSessionStore } from '../src/session-store.js';
import type {
  BackendClientPort,
  BackendFrame,
  BackendRetrievalPlan,
  BackendSearchResponse,
  BackendVqaAnswer,
} from '../src/types.js';

const playback = {
  video_id: 'video-1',
  playback_uri: 'https://signed.example/video.mp4',
  duration_ms: 10_000,
  fps: 25,
  mime_type: 'video/mp4' as const,
};

const plan: BackendRetrievalPlan = {
  query_id: 'plan-1',
  task: 'vqa',
  language: 'en',
  original_query: 'main query',
  query_variants: ['main query'],
  concepts: ['umbrella'],
  query_atoms: [],
  negative_concepts: [],
  text_constraints: [],
  audio_concepts: [],
  object_terms: [],
  object_constraints: { class_filters: [], excluded_classes: [], min_confidence: 0, counts: {}, spatial: [] },
  query_views: {},
  channel_weights: {},
  temporal_relations: [],
  target_granularities: ['frame'],
  branches: ['ocr_lexical'],
  top_k_per_branch: 10,
  fusion_k: 10,
  display_k: 10,
  rrf_k: 60,
  latency_budget_ms: 5_000,
  fallback_policy: 'expand_then_abstain',
  planner_version: 'test',
  fusion: 'rrf',
  index_version: 'test',
  hard_filters: {},
  transformations: [],
};

function frame(frameId: number, text: string): BackendFrame {
  return {
    video_id: 'video-1',
    keyframe_no: frameId + 1,
    original_frame_id: frameId,
    timestamp_ms: frameId * 100,
    captions: [{ evidence_id: `caption-${frameId}`, text, language: 'en', producer: 'test' }],
    ocr: [],
    objects: [],
    thumbnail_uri: 'https://signed.example/frame.jpg',
    is_exact_frame: true,
    annotation_source_frame_id: frameId,
    asr_spans: [],
  };
}

function result(frameId: number, score: number, text = 'umbrella') {
  return {
    video_id: 'video-1',
    original_frame_id: frameId,
    start_ms: frameId * 100,
    end_ms: frameId * 100 + 50,
    preview_uri: 'https://signed.example/frame.jpg',
    score,
    representative_frame: { keyframe_no: frameId + 1, original_frame_id: frameId, timestamp_ms: frameId * 100, preview_uri: null },
    evidence_ids: [`caption-${frameId}`],
    evidence: [{ evidence_id: `caption-${frameId}`, type: 'caption', snippet: text, producer: 'test' }],
    matched_modalities: ['caption'],
  };
}

function baseBackend(overrides: Partial<BackendClientPort> = {}): BackendClientPort {
  return {
    searchFrames: async () => ({ query_id: 'query-1', confidence: { level: 'high', score: 0.9, action: 'return' }, results: [result(10, 0.9)], warnings: [] }),
    searchExactFrames: async () => ({ query_id: 'exact-1', confidence: { level: 'high', score: 0.9, action: 'return' }, results: [], warnings: [] }),
    planSearch: async () => plan,
    getFrame: async (ref) => frame(ref.originalFrameId ?? 10, 'umbrella'),
    getFrameImage: async () => ({ bytes: Buffer.from([1]), mimeType: 'image/jpeg' }),
    getNearbyFrames: async () => ({ video_id: 'video-1', center_frame_id: 10, frames: [] }),
    getVideo: async () => playback,
    getStudio: async () => ({ video: playback, frames: [], asr_spans: [] }),
    getVqaAnswer: async () => ({
      result_id: 'answer-1', query_id: 'query-1', video_id: 'video-1', original_frame_id: 10, timestamp_ms: 1_000,
      answer_status: 'answered', answer: 'cái ô', normalized_answer: 'cái ô', evidence_ids: ['caption-10'],
      confidence: { level: 'high', score: 0.9 }, producer: 'test', model_version: 'test', verification: {},
    }),
    getCandidates: async () => ({ query_id: 'query-1', total: 1, limit: 20, offset: 0, candidates: [] }),
    getSelection: async () => null,
    previewSubmission: async () => ({ query_id: 'query-1', task: 'vqa', answer_count: 1, answers: [], csv: 'video-1,10,cái ô\r\n', submittable: false, warnings: [] }),
    ...overrides,
    getHealth: async () => ({ status: 'ok', service: 'test', mode: 'test', dependencies: {}, retrieval_branches: [], task_executors: [] }),
  };
}

function service(backend: BackendClientPort, options: { maxIterations?: number; maxToolCalls?: number } = {}) {
  return new SearchLoopService(backend, new SearchSessionStore(), {
    maxResults: 20,
    maxNearbyFrames: 5,
    maxIterations: options.maxIterations ?? 5,
    maxToolCalls: options.maxToolCalls ?? 30,
    timeBudgetMs: 60_000,
  });
}

describe('SearchLoopService', () => {
  it('reaches supported for grounded VQA evidence', async () => {
    const report = await service(baseBackend()).run({ task: 'vqa', query: 'người cầm ô', question: 'Người đang cầm gì?' });

    expect(report.status).toBe('supported');
    expect(report.confidence).toBeGreaterThanOrEqual(0.75);
    expect(report.evidence).toHaveLength(1);
    expect(report.vqa?.answer_status).toBe('answered');
    expect(report.toolCalls.map((call) => call.tool)).toEqual([
      'plan_search', 'search_frames', 'get_candidates', 'get_frame', 'suggest_vqa_answer',
    ]);
  });

  it('expands after VQA asks for more evidence', async () => {
    let answerCalls = 0;
    const backend = baseBackend({
      searchFrames: async () => ({ query_id: 'query-1', confidence: { level: 'medium', score: 0.55, action: 'expand' }, results: [result(10, 0.55)], warnings: [] }),
      getVqaAnswer: async (): Promise<BackendVqaAnswer> => {
        answerCalls += 1;
        return answerCalls === 1
          ? { result_id: 'answer-1', query_id: 'query-1', video_id: 'video-1', original_frame_id: 10, timestamp_ms: 1_000, answer_status: 'needs_more_evidence', answer: 'Không biết', normalized_answer: 'Không biết', evidence_ids: [], confidence: { level: 'low', score: 0.3 }, producer: 'test', model_version: 'test', verification: {} }
          : { result_id: 'answer-2', query_id: 'query-1', video_id: 'video-1', original_frame_id: 11, timestamp_ms: 1_100, answer_status: 'answered', answer: 'cái ô', normalized_answer: 'cái ô', evidence_ids: ['caption-11'], confidence: { level: 'high', score: 0.86 }, producer: 'test', model_version: 'test', verification: {} };
      },
      getNearbyFrames: async () => ({ video_id: 'video-1', center_frame_id: 10, frames: [{ video_id: 'video-1', keyframe_no: 12, original_frame_id: 11, timestamp_ms: 1_100, thumbnail_uri: 'https://signed.example/frame-11.jpg' }] }),
      getFrame: async (ref) => frame(ref.originalFrameId ?? 10, ref.originalFrameId === 11 ? 'umbrella' : 'unclear'),
    });

    const report = await service(backend).run({ task: 'vqa', query: 'người cầm ô', question: 'Người đang cầm gì?' });

    expect(report.status).toBe('supported');
    expect(answerCalls).toBe(2);
    expect(report.toolCalls.map((call) => call.tool)).toContain('get_nearby_frames');
  });

  it('keeps TRAKE retrieval on the main query while assessing four event frames', async () => {
    let searchInput: { query: string; task: string } | undefined;
    const backend = baseBackend({
      planSearch: async (input) => {
        searchInput = { query: input.query, task: input.task };
        return { ...plan, task: 'trake', original_query: input.query, query_variants: [input.query] };
      },
      searchFrames: async (input) => {
        searchInput = { query: input.query, task: input.task };
        return {
          query_id: 'query-trake', confidence: { level: 'high', score: 0.9, action: 'return' }, warnings: [],
          results: [result(10, 0.9, 'first event'), result(20, 0.88, 'second event'), result(30, 0.86, 'third event'), result(40, 0.84, 'fourth event')],
        };
      },
      getCandidates: async () => ({ query_id: 'query-trake', total: 4, limit: 20, offset: 0, candidates: [] }),
      getFrame: async (ref) => frame(ref.originalFrameId ?? 10, `${['first', 'second', 'third', 'fourth'][(ref.originalFrameId ?? 10) / 10 - 1] ?? 'event'} event`),
    });

    const report = await service(backend).run({
      task: 'trake',
      query: 'chuỗi sự kiện chính',
      events: ['first event', 'second event', 'third event', 'fourth event'],
    });

    expect(searchInput).toEqual({ query: 'chuỗi sự kiện chính', task: 'trake' });
    expect(report.trake?.requiredEvents).toHaveLength(4);
    expect(report.trake?.coveredEvents).toHaveLength(4);
    expect(report.trake?.chronological).toBe(true);
    expect(report.status).toBe('supported');
  });

  it('stops safely when the tool-call budget is exhausted', async () => {
    const report = await service(baseBackend({ getFrame: async () => { throw new Error('unavailable'); } }), { maxToolCalls: 5 }).run({ task: 'textual_kis', query: 'query' });

    expect(report.status).toBe('budget_exhausted');
    expect(report.stopReason).toContain('tool_call_budget');
    expect(report.toolCalls.length).toBeLessThanOrEqual(5);
  });
});
