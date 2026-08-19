import { describe, expect, it } from 'vitest';

import {
  buildAnswer,
  buildRankedTextualSubmission,
  buildSubmission,
  displayMatchedModalities,
  formatMs,
  groupEvidence,
  moveFrameToBoundary,
  parseFrame,
  reorderFrames,
  resultKey,
  toFrameCandidates,
  validateTrakeSequence,
} from '@/lib/workbench-model';
import type { FrameCandidate, SearchResponse, SearchResult } from '@/lib/contracts';

const result: SearchResult = {
  video_id: 'video_01',
  original_frame_id: 385,
  start_ms: 12_000,
  end_ms: 18_000,
  preview_uri: 's3://demo/video.webp',
  score: 0.93,
  evidence_ids: ['ev_ocr_01'],
  evidence: [
    {
      evidence_id: 'ev_ocr_01',
      type: 'ocr',
      start_ms: 14_800,
      end_ms: 16_800,
      snippet: 'Cửa hàng',
      producer: 'ocr:v1',
    },
  ],
  matched_modalities: ['visual', 'ocr'],
  representative_frame: {
    keyframe_no: 5,
    original_frame_id: 385,
    timestamp_ms: 15_400,
    preview_uri: null,
  },
};

describe('workbench answer model', () => {
  it('hides the visual embedding modality from user-facing labels', () => {
    expect(displayMatchedModalities(['embedding', 'object', 'ocr'])).toBe('object · ocr');
    expect(displayMatchedModalities(['visual', 'ocr'])).toBe('ocr');
    expect(displayMatchedModalities(['embedding'])).toBe('');
  });

  it('parses safe non-negative frame IDs and rejects malformed values', () => {
    expect(parseFrame(' 1500 ')).toBe(1500);
    expect(parseFrame('-1')).toBeNull();
    expect(parseFrame('1.5')).toBeNull();
    expect(parseFrame('9007199254740992')).toBeNull();
  });

  it('builds task-specific answers and submission payloads', () => {
    const textual = buildAnswer('textual_kis', result, '1500', '', ['', '', '', '']);
    const qa = buildAnswer('qa', result, '1500', 'Màu xanh', ['', '', '', '']);
    const trake = buildAnswer('trake', result, '', '', ['10', '20', '30', '40']);

    expect(textual).toEqual({ video_id: 'video_01', frame_id: 1500 });
    expect(qa).toEqual({ video_id: 'video_01', frame_id: 1500, answer: 'Màu xanh' });
    expect(trake).toEqual({ video_id: 'video_01', frame_ids: [10, 20, 30, 40] });
    expect(buildSubmission('qa', 'query_01', [qa!])).toEqual({
      query_id: 'query_01',
      task: 'qa',
      answers: [qa],
    });
  });

  it('rejects incomplete answers and formats timeline values', () => {
    expect(buildAnswer('qa', result, '1500', '   ', ['', '', '', ''])).toBeNull();
    expect(buildAnswer('trake', result, '', '', [])).toBeNull();
    expect(buildAnswer('trake', result, '', '', ['10', '', '30', '40'])).toBeNull();
    expect(buildSubmission('textual_kis', 'query_01', [])).toBeNull();
    expect(formatMs(12_340)).toBe('12.34s');
    expect(resultKey(result)).toBe('video_01\u0000385');
  });

  it('normalizes search results into browser-safe frame candidates', () => {
    const searchResponse: SearchResponse = {
      query_id: 'query_01',
      degraded: false,
      unavailable_branches: [],
      results: [result, { ...result, original_frame_id: null, representative_frame: null }],
    };

    const normalized = toFrameCandidates(searchResponse);

    expect(normalized.skipped).toBe(1);
    expect(normalized.frames[0]).toMatchObject({
      video_id: 'video_01',
      original_frame_id: 385,
      keyframe_no: 5,
      timestamp_ms: 15_400,
      thumbnail_uri: '/api/v1/media/keyframes/video_01/by-frame/385',
    });
  });

  it('groups evidence and validates a same-video increasing TRAKE sequence', () => {
    const candidate = toFrameCandidates({
      query_id: 'query_01',
      degraded: false,
      unavailable_branches: [],
      results: [result],
    }).frames[0];
    const next: FrameCandidate = { ...candidate, original_frame_id: 430, timestamp_ms: 17_000 };

    expect(groupEvidence(candidate.evidence).ocr).toHaveLength(1);
    expect(groupEvidence(candidate.evidence).asr).toHaveLength(0);
    expect(validateTrakeSequence([candidate, next])).toBe(true);
    expect(validateTrakeSequence([next, candidate])).toBe(false);
    expect(validateTrakeSequence([candidate, { ...next, video_id: 'video_02' }])).toBe(false);
  });

  it('keeps object evidence visible and filters bounded ASR to the frame timestamp', () => {
    const groups = groupEvidence([
      { evidence_id: 'object-1', type: 'object', snippet: 'person', producer: 'object:v1' },
      { evidence_id: 'asr-1', type: 'asr', start_ms: 1_000, end_ms: 2_000, snippet: 'đang đi', producer: 'asr:v1' },
      { evidence_id: 'asr-2', type: 'asr', start_ms: 4_000, end_ms: 5_000, snippet: 'đã rẽ', producer: 'asr:v1' },
    ], 1_500);

    expect(groups.object).toHaveLength(1);
    expect(groups.object[0].snippet).toBe('person');
    expect(groups.asr.map((item) => item.evidence_id)).toEqual(['asr-1']);
  });

  it('reorders ranked frames immutably and exports only the first 100 textual answers', () => {
    const frames = Array.from({ length: 101 }, (_, index) => ({
      result_key: `video_${index}`,
      video_id: `video_${index}`,
      original_frame_id: index,
      timestamp_ms: index * 1_000,
      thumbnail_uri: `/frame/${index}`,
      start_ms: index * 1_000,
      end_ms: index * 1_000 + 500,
      score: 1 - index / 200,
      evidence: [],
      matched_modalities: [],
    } satisfies FrameCandidate));

    const reordered = reorderFrames(frames, 2, 0);
    const submission = buildRankedTextualSubmission('query_ranked', reordered);

    expect(reordered).not.toBe(frames);
    expect(reordered.slice(0, 4).map((frame) => frame.original_frame_id)).toEqual([2, 0, 1, 3]);
    expect(frames.slice(0, 3).map((frame) => frame.original_frame_id)).toEqual([0, 1, 2]);
    expect(submission).toMatchObject({ query_id: 'query_ranked', task: 'textual_kis' });
    expect(submission?.answers).toHaveLength(100);
    expect(submission?.answers[0]).toEqual({ video_id: 'video_2', frame_id: 2 });
    expect(submission?.answers[99]).toEqual({ video_id: 'video_99', frame_id: 99 });
  });

  it('moves a ranked frame directly to the top or bottom without mutating the input', () => {
    const frames = Array.from({ length: 4 }, (_, index) => ({
      result_key: `video_${index}`,
      video_id: `video_${index}`,
      original_frame_id: index,
      timestamp_ms: index * 1_000,
      thumbnail_uri: `/frame/${index}`,
      start_ms: index * 1_000,
      end_ms: index * 1_000 + 500,
      score: 1 - index / 10,
      evidence: [],
      matched_modalities: [],
    } satisfies FrameCandidate));

    const top = moveFrameToBoundary(frames, 2, 'top');
    const bottom = moveFrameToBoundary(frames, 1, 'bottom');

    expect(top.map((frame) => frame.original_frame_id)).toEqual([2, 0, 1, 3]);
    expect(bottom.map((frame) => frame.original_frame_id)).toEqual([0, 2, 3, 1]);
    expect(moveFrameToBoundary(frames, 0, 'top')).toEqual(frames);
    expect(moveFrameToBoundary(frames, 3, 'bottom')).toEqual(frames);
    expect(frames.map((frame) => frame.original_frame_id)).toEqual([0, 1, 2, 3]);
  });
});
