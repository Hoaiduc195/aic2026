import { describe, expect, it } from 'vitest';

import { TraceService } from '../src/trace-service.js';
import type { BackendClientPort } from '../src/types.js';

function fakeBackend(): BackendClientPort {
  return {
    searchFrames: async () => ({
      query_id: 'q-1',
      confidence: { level: 'high', score: 0.91, action: 'return' },
      warnings: [],
      results: [
        {
          video_id: 'v-1',
          original_frame_id: 10,
          start_ms: 1000,
          end_ms: 2000,
          score: 0.91,
          preview_uri: 'r2://preview',
          representative_frame: { keyframe_no: 2, original_frame_id: 10, timestamp_ms: 1200, preview_uri: 'r2://preview' },
          evidence_ids: ['ocr-1'],
          evidence: [{ evidence_id: 'ocr-1', type: 'ocr', snippet: 'umbrella', producer: 'ocr' }],
          matched_modalities: ['ocr'],
        },
      ],
    }),
    getFrame: async () => ({
      video_id: 'v-1',
      keyframe_no: 2,
      original_frame_id: 10,
      timestamp_ms: 1200,
      captions: [],
      ocr: [{ evidence_id: 'ocr-1', text: 'umbrella', language: 'en', producer: 'ocr' }],
      objects: [],
      thumbnail_uri: 'http://signed/frame.jpg',
      is_exact_frame: true,
      annotation_source_frame_id: 10,
      asr_spans: [],
    }),
    getFrameImage: async () => ({ bytes: Buffer.from([1]), mimeType: 'image/jpeg' }),
    getNearbyFrames: async () => ({ video_id: 'v-1', center_frame_id: 10, frames: [] }),
    getVideo: async () => ({ video_id: 'v-1', playback_uri: 'http://signed/video.mp4', duration_ms: 5000, fps: 25, mime_type: 'video/mp4' }),
    getStudio: async () => ({ video: { video_id: 'v-1', playback_uri: 'http://signed/video.mp4', duration_ms: 5000, fps: 25, mime_type: 'video/mp4' }, frames: [], asr_spans: [] }),
    searchExactFrames: async () => ({ query_id: 'q-exact', warnings: [], results: [] }),
    planSearch: async () => { throw new Error('not used'); },
    getVqaAnswer: async () => { throw new Error('not used'); },
    getCandidates: async () => { throw new Error('not used'); },
    getSelection: async () => null,
    previewSubmission: async () => { throw new Error('not used'); },
    getHealth: async () => { throw new Error('not used'); },
  };
}

describe('TraceService', () => {
  it('returns traceable search results with exact frame evidence', async () => {
    const trace = await new TraceService(fakeBackend(), { maxResults: 5, maxNearbyFrames: 5 }).traceAnswer({
      query: 'người cầm ô',
      task: 'vqa',
      includeNearby: true,
    });

    expect(trace.verdict).toBe('supported');
    expect(trace.queryId).toBe('q-1');
    expect(trace.supportingFrames).toEqual([{ videoId: 'v-1', originalFrameId: 10, keyframeNo: 2 }]);
    expect(trace.evidence[0]).toMatchObject({ videoId: 'v-1', originalFrameId: 10, ocr: ['umbrella'] });
    expect(trace.toolCalls.map((call) => call.tool)).toEqual(['search_frames', 'get_frame', 'get_nearby_frames']);
  });

  it('abstains when retrieval returns no results', async () => {
    const backend = fakeBackend();
    backend.searchFrames = async () => ({ query_id: 'q-empty', confidence: { level: 'unknown', score: 0, action: 'abstain' }, warnings: [], results: [] });

    const trace = await new TraceService(backend, { maxResults: 5, maxNearbyFrames: 5 }).traceAnswer({
      query: 'không có kết quả',
      task: 'trake',
    });

    expect(trace.verdict).toBe('insufficient');
    expect(trace.supportingFrames).toEqual([]);
    expect(trace.missingEvidence).toContain('No matching frames were returned by retrieval');
  });

  it('uses exact-frame candidates and marks unavailable evidence without throwing', async () => {
    const backend = fakeBackend();
    backend.searchExactFrames = async () => ({
      query_id: 'q-exact',
      confidence: { level: 'medium', score: 0.6, action: 'return' },
      warnings: ['exact lookup warning'],
      results: [{
        video_id: 'v-1', original_frame_id: 10, start_ms: 1000, end_ms: 2000, preview_uri: 'r2://preview', score: 0.6,
        evidence_ids: [], evidence: [], matched_modalities: [],
      }],
    });
    backend.getFrame = async () => { throw new Error('frame unavailable'); };
    backend.getNearbyFrames = async () => { throw new Error('nearby unavailable'); };

    const trace = await new TraceService(backend, { maxResults: 5, maxNearbyFrames: 5 }).traceAnswer({
      query: 'candidate',
      task: 'trake',
      candidateFrames: [{ videoId: 'v-1', originalFrameId: 10 }],
      includeNearby: true,
    });

    expect(trace.verdict).toBe('insufficient');
    expect(trace.toolCalls.map((call) => `${call.tool}:${call.status}`)).toEqual(['search_exact_frames:ok', 'get_frame:error']);
    expect(trace.warnings).toContain('frame_unavailable:v-1:10');
  });

  it('compares visual candidates and ranks textual evidence', async () => {
    const backend = fakeBackend();
    const service = new TraceService(backend, { maxResults: 5, maxNearbyFrames: 5 });
    const comparison = await service.compareFrames({
      reference: { videoId: 'v-1', keyframeNo: 2 },
      candidates: [{ videoId: 'v-1', originalFrameId: 10 }, { videoId: 'v-1', originalFrameId: 999 }],
      task: 'vqa',
    });
    expect(comparison.reference).toEqual({ videoId: 'v-1', originalFrameId: 10 });
    expect(comparison.candidates[0]).toMatchObject({ videoId: 'v-1', originalFrameId: 10, rank: 1 });
    expect(comparison.missingCandidates).toEqual([{ videoId: 'v-1', originalFrameId: 999 }]);

    const ranked = await service.rankFrames({
      query: 'umbrella',
      candidates: [{ videoId: 'v-1', originalFrameId: 10 }],
      task: 'vqa',
    });
    expect(ranked.candidates[0]).toMatchObject({ score: 1, rank: 1 });
    expect(ranked.evidence[0].ocr).toEqual(['umbrella']);
  });
});
