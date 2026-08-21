import { describe, expect, it } from 'vitest';

import {
  autoBuildTrakeAnswers,
  autoSelectNearbyTrakeFrames,
  buildAnswer,
  buildRankedTextualSubmission,
  buildSubmission,
  displayMatchedModalities,
  formatMs,
  groupEvidence,
  applyStudioFrameToCandidate,
  applyCanonicalFrameToCandidate,
  moveFrameToBoundary,
  parseFrame,
  reorderFrames,
  resultKey,
  toFrameCandidates,
  validateTrakeSequence,
  normalizeFrameCandidate,
} from '@/lib/workbench-model';
import type { FrameCandidate, SearchResponse, SearchResult, StudioFrame } from '@/lib/contracts';

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

  it('uses the exact-frame thumbnail proxy for manually looked-up non-keyframes', () => {
    const normalized = toFrameCandidates({
      query_id: 'query_exact',
      query_mode: 'exact_frames',
      degraded: false,
      unavailable_branches: [],
      results: [result],
    });

    expect(normalized.frames[0]).toMatchObject({
      thumbnail_uri: '/api/v1/media/videos/video_01/frames/385/thumbnail',
      is_exact_frame: true,
      annotation_source_frame_id: null,
    });
  });

  it('rewrites signed preview URLs to a stable media proxy', () => {
    const normalized = toFrameCandidates({
      query_id: 'query_01',
      degraded: false,
      unavailable_branches: [],
      results: [{
        ...result,
        preview_uri: 'https://r2.example/frame.webp?X-Amz-Signature=expired',
      }],
    });

    expect(normalized.frames[0].thumbnail_uri).toBe('/api/v1/media/keyframes/video_01/by-frame/385');
  });

  it('groups evidence and validates a same-video increasing TRAKE sequence', () => {
    const candidate = toFrameCandidates({
      query_id: 'query_01',
      degraded: false,
      unavailable_branches: [],
      results: [result],
    }).frames[0];
    const next: FrameCandidate = { ...candidate, original_frame_id: 430, timestamp_ms: 17_000 };
    const third: FrameCandidate = { ...candidate, original_frame_id: 475, timestamp_ms: 22_000 };
    const fourth: FrameCandidate = { ...candidate, original_frame_id: 520, timestamp_ms: 28_000 };

    expect(groupEvidence(candidate.evidence).ocr).toHaveLength(1);
    expect(groupEvidence(candidate.evidence).asr).toHaveLength(0);
    expect(validateTrakeSequence([candidate, next, third, fourth])).toBe(true);
    expect(validateTrakeSequence([next, candidate, third, fourth])).toBe(false);
    expect(validateTrakeSequence([candidate, next, third])).toBe(false);
    expect(validateTrakeSequence([candidate, next, third, { ...fourth, video_id: 'video_02' }])).toBe(false);
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

  it('keeps OCR and active ASR evidence when a Studio frame replaces a search candidate', () => {
    const candidate = toFrameCandidates({
      query_id: 'query_01',
      degraded: false,
      unavailable_branches: [],
      results: [result],
    }).frames[0];
    const studioFrame = {
      video_id: 'video_01',
      keyframe_no: 6,
      original_frame_id: 420,
      timestamp_ms: 16_000,
      captions: [],
      objects: [],
      ocr: [{ evidence_id: 'ocr-2', text: 'GIẢM GIÁ', language: 'vi', producer: 'ocr:v1' }],
    } as StudioFrame & { ocr: { evidence_id: string; text: string; language: string; producer: string }[] };

    const selected = applyStudioFrameToCandidate(candidate, studioFrame, [{
      evidence_id: 'asr-2', start_ms: 15_000, end_ms: 17_000,
      text: 'Khuyến mãi hôm nay', language: 'vi', producer: 'asr:v1',
    }]);

    expect(groupEvidence(selected.evidence, selected.timestamp_ms).ocr.map((item) => item.snippet)).toEqual(['GIẢM GIÁ']);
    expect(groupEvidence(selected.evidence, selected.timestamp_ms).asr.map((item) => item.snippet)).toEqual(['Khuyến mãi hôm nay']);
  });

  it('keeps OCR and ASR returned with a canonical frame', () => {
    const candidate = toFrameCandidates({
      query_id: 'query_01',
      degraded: false,
      unavailable_branches: [],
      results: [result],
    }).frames[0];
    const selected = applyCanonicalFrameToCandidate(candidate, {
      video_id: 'video_01',
      original_frame_id: 421,
      timestamp_ms: 16_500,
      captions: [],
      ocr: [{ evidence_id: 'ocr-3', text: 'MỞ CỬA', language: 'vi', producer: 'ocr:v1' }],
      objects: [],
      thumbnail_uri: '/frame/421',
      is_exact_frame: true,
      annotation_source_frame_id: 420,
      asr_spans: [{
        evidence_id: 'asr-3', start_ms: 16_000, end_ms: 17_000,
        text: 'Cửa hàng mở cửa', language: 'vi', producer: 'asr:v1',
      }],
    });

    const evidence = groupEvidence(selected.evidence, selected.timestamp_ms);
    expect(evidence.ocr.map((item) => item.snippet)).toEqual(['MỞ CỬA']);
    expect(evidence.asr.map((item) => item.snippet)).toEqual(['Cửa hàng mở cửa']);
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
    expect(frames.map((frame) => frame.original_frame_id)).toEqual([0, 1, 2, 3]);
  });

  it('auto-selects four chronological frames for TRAKE around an anchor', () => {
    const anchor: FrameCandidate = {
      result_key: 'video_01\u0000200',
      video_id: 'video_01',
      original_frame_id: 200,
      timestamp_ms: 8_000,
      thumbnail_uri: '/frame/200',
      start_ms: 8_000,
      end_ms: 8_500,
      score: 0.9,
      evidence: [],
      matched_modalities: [],
    };

    const available: FrameCandidate[] = [
      { ...anchor, original_frame_id: 100, timestamp_ms: 4_000 },
      anchor,
      { ...anchor, original_frame_id: 300, timestamp_ms: 12_000 },
      { ...anchor, original_frame_id: 400, timestamp_ms: 16_000 },
      { ...anchor, original_frame_id: 500, timestamp_ms: 20_000 },
    ];

    const selected = autoSelectNearbyTrakeFrames(anchor, available);
    expect(selected).toHaveLength(4);
    expect(validateTrakeSequence(selected)).toBe(true);
    expect(selected.map((f) => f.original_frame_id)).toEqual([200, 300, 400, 500]);
  });

  it('does not fabricate frame IDs when nearby real frames are insufficient', () => {
    const anchor: FrameCandidate = {
      result_key: 'video_01\\u0000200',
      video_id: 'video_01',
      original_frame_id: 200,
      timestamp_ms: 8_000,
      thumbnail_uri: '/frame/200',
      start_ms: 8_000,
      end_ms: 8_500,
      score: 0.9,
      evidence: [],
      matched_modalities: [],
    };

    expect(autoSelectNearbyTrakeFrames(anchor, [anchor])).toEqual([]);
  });

  it('preserves the exact-frame thumbnail route when normalizing a manually selected frame', () => {
    const exact: FrameCandidate = {
      ...resultToCandidate(),
      is_exact_frame: true,
      thumbnail_uri: '/api/v1/media/videos/video_01/frames/386/thumbnail',
      original_frame_id: 386,
    };

    expect(normalizeFrameCandidate(exact).thumbnail_uri).toBe(
      '/api/v1/media/videos/video_01/frames/386/thumbnail',
    );
  });

  it('auto-builds batch TRAKE answers from ranked retrieval frames', () => {
    const ranked: FrameCandidate[] = [
      {
        result_key: 'video_01\u0000100',
        video_id: 'video_01',
        original_frame_id: 100,
        timestamp_ms: 4_000,
        thumbnail_uri: '/frame/100',
        start_ms: 4_000,
        end_ms: 4_500,
        score: 0.95,
        evidence: [],
        matched_modalities: [],
      },
      {
        result_key: 'video_01\u0000200',
        video_id: 'video_01',
        original_frame_id: 200,
        timestamp_ms: 8_000,
        thumbnail_uri: '/frame/200',
        start_ms: 8_000,
        end_ms: 8_500,
        score: 0.90,
        evidence: [],
        matched_modalities: [],
      },
      {
        result_key: 'video_01\u0000300',
        video_id: 'video_01',
        original_frame_id: 300,
        timestamp_ms: 12_000,
        thumbnail_uri: '/frame/300',
        start_ms: 12_000,
        end_ms: 12_500,
        score: 0.88,
        evidence: [],
        matched_modalities: [],
      },
      {
        result_key: 'video_01\u0000400',
        video_id: 'video_01',
        original_frame_id: 400,
        timestamp_ms: 16_000,
        thumbnail_uri: '/frame/400',
        start_ms: 16_000,
        end_ms: 16_500,
        score: 0.87,
        evidence: [],
        matched_modalities: [],
      },
      {
        result_key: 'video_02\u000050',
        video_id: 'video_02',
        original_frame_id: 50,
        timestamp_ms: 2_000,
        thumbnail_uri: '/frame/50',
        start_ms: 2_000,
        end_ms: 2_500,
        score: 0.85,
        evidence: [],
        matched_modalities: [],
      },
    ];

    const answers = autoBuildTrakeAnswers(ranked, 10);
    expect(answers).toHaveLength(1);
    expect(answers[0].video_id).toBe('video_01');
    expect(answers[0].frame_ids).toHaveLength(4);
    expect(answers[0].frame_ids).toEqual([100, 200, 300, 400]);
  });
});

function resultToCandidate(): FrameCandidate {
  return {
    result_key: 'video_01\\u0000385',
    video_id: 'video_01',
    original_frame_id: 385,
    timestamp_ms: 15_400,
    thumbnail_uri: '/frame/385',
    start_ms: 12_000,
    end_ms: 18_000,
    score: 0.93,
    evidence: [],
    matched_modalities: [],
  };
}

