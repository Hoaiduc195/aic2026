import { describe, expect, it } from 'vitest';

import {
  parseCandidatePageResponse,
  parseFrameResponse,
  parseHealthResponse,
  parsePlanResponse,
  parsePlaybackResponse,
  parseSearchResponse,
  parseSelectionResponse,
  parseStudioResponse,
  parseSubmissionPreviewResponse,
  parseVideoFramesResponse,
  parseVqaAnswerResponse,
} from '../src/backend-response.js';

const caption = { evidence_id: 'caption-1', text: 'person', language: 'en', producer: 'captioner' };
const ocr = { evidence_id: 'ocr-1', text: 'SALE', language: 'en', producer: 'ocr' };
const object = { evidence_id: 'object-1', label: 'person', confidence: 0.9, normalized_bbox: [0.1, 0.2, 0.4, 0.8], producer: 'detector' };
const asr = { evidence_id: 'asr-1', start_ms: 10, end_ms: 100, text: 'hello', language: 'en', producer: 'asr' };

describe('backend response validation', () => {
  it('parses a full search response including representative frame and evidence', () => {
    const result = parseSearchResponse({
      request_id: 'request-1',
      query_id: 'query-1',
      confidence: { level: 'high', score: 0.95, action: 'return' },
      warnings: ['degraded'],
      results: [{
        video_id: 'video-1',
        original_frame_id: 4,
        start_ms: 100,
        end_ms: 200,
        preview_uri: 'r2://preview',
        score: 0.8,
        representative_frame: { keyframe_no: 2, original_frame_id: 4, timestamp_ms: 120, preview_uri: null },
        evidence_ids: ['ocr-1'],
        evidence: [{ evidence_id: 'ocr-1', type: 'ocr', start_ms: 100, end_ms: 200, snippet: 'SALE', producer: 'ocr' }],
        matched_modalities: ['ocr'],
      }],
    });

    expect(result.results[0]).toMatchObject({ video_id: 'video-1', original_frame_id: 4, representative_frame: { keyframe_no: 2 } });
    expect(result.confidence?.action).toBe('return');
  });

  it('parses a complete exact frame response', () => {
    const result = parseFrameResponse({
      video_id: 'video-1',
      keyframe_no: 2,
      original_frame_id: 4,
      timestamp_ms: 120,
      captions: [caption],
      ocr: [ocr],
      objects: [object],
      thumbnail_uri: 'https://signed.example/frame.jpg',
      is_exact_frame: true,
      annotation_source_frame_id: 4,
      asr_spans: [asr],
    });

    expect(result).toMatchObject({ video_id: 'video-1', keyframe_no: 2, original_frame_id: 4 });
    expect(result.objects[0].normalized_bbox).toEqual([0.1, 0.2, 0.4, 0.8]);
  });

  it('parses playback, nearby frames and studio responses', () => {
    const playback = { video_id: 'video-1', playback_uri: 'https://signed.example/video.mp4', duration_ms: 5000, fps: 25, frame_count: 125, mime_type: 'video/mp4' };
    expect(parsePlaybackResponse(playback).frame_count).toBe(125);
    expect(parseVideoFramesResponse({
      video_id: 'video-1',
      center_frame_id: 4,
      frames: [{ video_id: 'video-1', keyframe_no: 2, original_frame_id: 4, timestamp_ms: 120, thumbnail_uri: 'https://signed.example/frame.jpg' }],
    }).frames).toHaveLength(1);
    expect(parseStudioResponse({
      video: playback,
      frames: [{ video_id: 'video-1', keyframe_no: 2, original_frame_id: 4, timestamp_ms: 120, captions: [caption], ocr: [ocr], objects: [object] }],
      asr_spans: [asr],
    }).asr_spans[0].text).toBe('hello');
  });

  it('rejects malformed external responses', () => {
    expect(() => parseSearchResponse({ query_id: 'q', results: [{ video_id: 'v' }] })).toThrow();
    expect(() => parseFrameResponse({ video_id: 'v', is_exact_frame: false })).toThrow();
    expect(() => parsePlaybackResponse({ video_id: 'v', mime_type: 'application/octet-stream' })).toThrow();
    expect(() => parseVideoFramesResponse({ video_id: 'v', center_frame_id: 0, frames: [{ keyframe_no: 0 }] })).toThrow();
    expect(() => parseStudioResponse({ video: {}, frames: [] })).toThrow();
  });

  it('validates read-only planning, VQA, candidate, preview and health responses', () => {
    const plan = parsePlanResponse({
      query_id: 'q-1', task: 'trake', language: 'en', original_query: 'main', query_variants: ['main'], concepts: [], query_atoms: [],
      negative_concepts: [], text_constraints: [], audio_concepts: [], object_terms: [], object_constraints: {}, query_views: {}, channel_weights: {},
      temporal_relations: [], target_granularities: ['frame'], branches: ['caption'], top_k_per_branch: 10, fusion_k: 10, display_k: 10,
      rrf_k: 60, latency_budget_ms: 5000, fallback_policy: 'expand_then_abstain', planner_version: 'test', fusion: 'rrf', index_version: 'idx',
      hard_filters: {}, transformations: [],
    });
    expect(plan.task).toBe('trake');
    expect(parseVqaAnswerResponse({
      result_id: 'r-1', query_id: 'q-1', video_id: 'v-1', original_frame_id: 4, timestamp_ms: 100,
      answer_status: 'answered', answer: 'ô', normalized_answer: 'ô', evidence_ids: ['e-1'], confidence: { level: 'high', score: 0.9 },
      producer: 'test', model_version: 'test', verification: {},
    }).confidence.score).toBe(0.9);
    expect(parseCandidatePageResponse({ query_id: 'q-1', total: 1, limit: 10, offset: 0, candidates: [{
      rank: 1, video_id: 'v-1', original_frame_id: 4, start_ms: 0, end_ms: 100, preview_uri: 'r2://preview', score: 0.8,
      evidence_ids: [], matched_modalities: ['caption'], fusion_trace: [],
    }] }).candidates).toHaveLength(1);
    expect(parseSelectionResponse(null)).toBeNull();
    expect(parseSubmissionPreviewResponse({ query_id: 'q-1', task: 'vqa', answer_count: 1, answers: [{ video_id: 'v-1', frame_id: 4, answer: 'ô' }], csv: 'v-1,4,ô\r\n', submittable: false, warnings: [] }).submittable).toBe(false);
    expect(parseHealthResponse({ status: 'ok', service: 'backend', mode: 'offline-first', dependencies: { database: 'healthy' }, retrieval_branches: ['caption'], task_executors: ['vqa'] }).status).toBe('ok');
  });

  it('rejects unsafe or incomplete read-only response shapes', () => {
    expect(() => parsePlanResponse({ query_id: 'q', task: 'vqa', original_query: 'q' })).toThrow();
    expect(() => parseVqaAnswerResponse({ answer_status: 'answered' })).toThrow();
    expect(() => parseCandidatePageResponse({ query_id: 'q', total: 1, limit: 1, offset: 0, candidates: [{ rank: 0 }] })).toThrow();
    expect(() => parseSubmissionPreviewResponse({ query_id: 'q', task: 'vqa', answer_count: 1, answers: [], csv: '', submittable: false, warnings: [] })).toThrow();
    expect(() => parseHealthResponse({ status: 'ok', dependencies: {} })).toThrow();
  });

  it('covers optional fields returned by configured backend branches', () => {
    expect(parsePlanResponse({
      query_id: 'q', task: 'vqa', language: 'mixed', original_query: 'q', query_mode: 'frame_image',
      frame_query: { video_id: 'v-1', original_frame_id: 4 }, query_variants: ['q'], concepts: ['person'],
      query_atoms: [{ id: 'a-1', type: 'object', value: 'person', weight: 1 }], negative_concepts: ['car'], text_constraints: ['text'],
      audio_concepts: ['sound'], object_terms: ['person'], object_constraints: { counts: { person: 1 } }, query_views: { caption: 'q' },
      channel_weights: { caption: 1 }, temporal_relations: ['near'], target_granularities: ['frame'], branches: ['caption'],
      top_k_per_branch: 1, fusion_k: 1, display_k: 1, near_frame_window_ms: 100, rrf_k: 1, latency_budget_ms: 100,
      fallback_policy: 'none', planner_version: 'test', fusion: 'rrf', index_version: 'idx', hard_filters: { task: 'vqa' }, transformations: ['normalize'],
    }).frame_query?.original_frame_id).toBe(4);
    expect(parseVqaAnswerResponse({
      result_id: 'r', query_id: 'q', video_id: 'v', original_frame_id: 1, timestamp_ms: 2, answer_status: 'needs_more_evidence',
      answer: null, normalized_answer: null, evidence_ids: [], confidence: { level: 'low', score: 0 }, producer: 'test', model_version: 'test',
    }).answer).toBeNull();
    expect(parseCandidatePageResponse({ query_id: 'q', total: 1, limit: 1, offset: 0, candidates: [{
      rank: 1, video_id: 'v', original_frame_id: null, start_ms: 0, end_ms: 1, score: 0, evidence_ids: [], matched_modalities: [],
    }] }).candidates[0].preview_uri).toBeUndefined();
    expect(parseSelectionResponse({ selection_id: 's', query_id: 'q', revision: 1, task: 'textual_kis', answers: [], note: null, created_at: 'now' })?.revision).toBe(1);
    expect(parseSubmissionPreviewResponse({ query_id: 'q', task: 'textual_kis', answer_count: 1, answers: [{ video_id: 'v', frame_id: 1 }], csv: 'v,1\r\n', submittable: false }).warnings).toEqual([]);
  });
});
