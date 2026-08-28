import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSubmissionPreview,
  getVideoFrame,
  getVideoKeyframe,
  getVideoFrames,
  getVideoPlayback,
  getVideoStudio,
  improveQuery,
  parseQueryImprovementResponse,
  parseSearchResponse,
  parseVideoStudioResponse,
  saveSelection,
  searchMedia,
  searchExactFrames,
} from '@/lib/api';
import type { SearchResponse } from '@/lib/contracts';

const validResponse: SearchResponse = {
  request_id: 'request_0001',
  query_id: 'query_0001',
  task: 'textual_kis',
  task_executor: 'textual_kis_v1',
  dataset_version: 'qualification-v1',
  pipeline_version: 'pipe-v2',
  schema_version: '1.0.0',
  index_version: 'idx-v1',
  degraded: false,
  unavailable_branches: [],
  confidence: { level: 'high', score: 0.91 },
  results: [
    {
      video_id: 'video_01',
      original_frame_id: 385,
      start_ms: 0,
      end_ms: 1000,
      preview_uri: 's3://demo/frame.webp',
      score: 0.9,
      evidence_ids: [],
      evidence: [],
      matched_modalities: ['visual'],
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('search API boundary', () => {
  it('posts an exact-frame batch without entering semantic retrieval', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ...validResponse,
      query: 'Exact frame lookup',
      query_mode: 'exact_frames',
    }), { status: 200 })));

    const result = await searchExactFrames({
      task: 'textual_kis',
      frames: [{ video_id: 'video_01', original_frame_id: 385 }],
    });

    expect(result.query_mode).toBe('exact_frames');
    expect(fetch).toHaveBeenCalledWith('/api/v1/search/exact-frames', expect.objectContaining({ method: 'POST' }));
  });

  it('loads a canonical frame by keyframe ordinal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      video_id: 'video_01', keyframe_no: 7, original_frame_id: 385, timestamp_ms: 12_800,
      captions: [], ocr: [], objects: [], asr_spans: [],
      thumbnail_uri: '/api/v1/media/videos/video_01/frames/385/thumbnail',
      is_exact_frame: true, annotation_source_frame_id: null,
    }), { status: 200 })));

    await expect(getVideoKeyframe('video_01', 7)).resolves.toMatchObject({
      keyframe_no: 7, original_frame_id: 385,
    });
    expect(fetch).toHaveBeenCalledWith('/api/v1/videos/video_01/keyframes/7', expect.anything());
  });

  it('calls the query improver API and parses its response contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      original_query: 'một người đi bộ',
      improved_query: 'A person walking.',
      changed: true,
      producer: 'query-improver-openai-compatible',
      model_version: 'model-a',
      warning: null,
    }), { status: 200 })));

    const result = await improveQuery({ query: 'một người đi bộ', task: 'textual_kis' });

    expect(result).toMatchObject({ improved_query: 'A person walking.', changed: true });
    expect(fetch).toHaveBeenCalledWith('/api/v1/query/improve', expect.objectContaining({ method: 'POST' }));
  });

  it('parses separate ordered TRAKE improvement fields', () => {
    expect(parseQueryImprovementResponse({
      original_query: 'Một người đi qua cửa hàng',
      improved_query: 'A person crosses a shop',
      original_events: ['Người bước vào'],
      improved_events: ['The person enters'],
      changed: true,
      producer: 'query-improver-openai-compatible',
      model_version: 'model-a',
      warning: null,
    })).toMatchObject({
      improved_query: 'A person crosses a shop',
      original_events: ['Người bước vào'],
      improved_events: ['The person enters'],
    });
  });

  it('accepts signed R2 preview URLs with query parameters', () => {
    const parsed = parseSearchResponse({
      ...validResponse,
      results: [
        {
          ...validResponse.results[0],
          preview_uri: 'https://cdn.example.com/frame.webp?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=test',
        },
      ],
    });

    expect(parsed.results[0].preview_uri).toContain('?X-Amz-Algorithm=');
  });

  it('parses the frame-image query mode returned by the backend', () => {
    expect(parseSearchResponse({ ...validResponse, query: '', query_mode: 'frame_image' })).toMatchObject({
      query: '',
      query_mode: 'frame_image',
    });
    expect(parseSearchResponse({ ...validResponse, query_mode: 'exact_frames' })).toMatchObject({
      query_mode: 'exact_frames',
    });
    expect(() => parseSearchResponse({ ...validResponse, query_mode: 'unknown' })).toThrow('query_mode');
  });

  it('normalizes legacy timestamp aliases and validates response versions', () => {
    const parsed = parseSearchResponse({
      ...validResponse,
      results: [
        {
          ...validResponse.results[0],
          start_ms: undefined,
          end_ms: undefined,
          timestamp_start_ms: 200,
          timestamp_end_ms: 900,
        },
      ],
    });

    expect(parsed.results[0]).toMatchObject({ start_ms: 200, end_ms: 900 });
  });

  it('rejects malformed candidates and incompatible confidence values', () => {
    expect(() => parseSearchResponse({ ...validResponse, confidence: { level: 'high', score: 2 } })).toThrow(
      'confidence.score',
    );
    expect(() =>
      parseSearchResponse({
        ...validResponse,
        results: [{ ...validResponse.results[0], end_ms: 0 }],
      }),
    ).toThrow('end_ms');
  });

  it('accepts optional contract fields and legacy evidence shapes', () => {
    const parsed = parseSearchResponse({
      request_id: 'request_0002',
      query_id: 'query_0002',
      query: 'người cầm ô',
      session_id: 'session_01',
      task: 'vqa',
      task_executor: 'vqa_v1',
      dataset_version: 'qualification-v1',
      pipeline_version: 'pipe-v3',
      schema_version: '1.2.3',
      index_version: 'idx-v2',
      degraded: true,
      unavailable_branches: ['asr', 'asr'],
      confidence: {
        level: 'medium',
        score: 0.6,
        fallbacks_applied: ['ocr'],
        action: 'expand',
      },
      results: [
        {
          video_id: 'video_02',
          original_frame_id: 120,
          start_ms: 100,
          end_ms: 900,
          preview_uri: 'https://cdn.example.com/preview.mp4',
          score: 0.6,
          representative_frame: {
            original_frame_id: 120,
            timestamp_ms: 300,
            preview_uri: null,
          },
          evidence_ids: ['ev_01', 'ev_01'],
          evidence: [
            {
              evidence_id: 'ev_01',
              type: 'ocr',
              start_ms: 150,
              end_ms: 250,
              snippet: null,
              producer: 'ocr-v1',
            },
            {
              evidence_id: 'ev_02',
              type: 'audio',
              producer: 'asr-v1',
              snippet: 'một câu nói',
            },
          ],
          matched_modalities: ['ocr', 'asr'],
        },
      ],
      timing: { retrieval_ms: 12 },
      warnings: ['nhánh asr suy giảm'],
    });

    expect(parsed).toMatchObject({
      session_id: 'session_01',
      degraded: true,
      unavailable_branches: ['asr'],
      confidence: { level: 'medium', action: 'expand' },
      timing: { retrieval_ms: 12 },
    });
    expect(parsed.results[0].representative_frame).toEqual({
      original_frame_id: 120,
      timestamp_ms: 300,
      preview_uri: null,
    });
    expect(parsed.results[0].evidence[1]).toMatchObject({ type: 'audio', start_ms: undefined });
  });

  it('rejects invalid values at every response boundary', () => {
    const invalidCases: Array<[unknown, string]> = [
      [null, 'response phải là object'],
      [{ ...validResponse, query_id: '' }, 'query_id'],
      [{ ...validResponse, results: {} }, 'results phải là array'],
      [{ ...validResponse, task: 'unknown' }, 'task không hợp lệ'],
      [{ ...validResponse, schema_version: 'v1' }, 'schema_version'],
      [{ ...validResponse, degraded: 'yes' }, 'degraded'],
      [{ ...validResponse, unavailable_branches: [1] }, 'unavailable_branches'],
      [{ ...validResponse, warnings: [1] }, 'warnings'],
      [{ ...validResponse, confidence: null }, 'confidence phải là object'],
      [{ ...validResponse, confidence: { level: 'certain', score: 0.5 } }, 'confidence.level'],
      [{ ...validResponse, confidence: { level: 'high', score: 0.5, action: 'retry' } }, 'confidence.action'],
      [
        { ...validResponse, results: [null] },
        'results[0] phải là object',
      ],
      [
        { ...validResponse, results: [{ ...validResponse.results[0], preview_uri: 'http://bad uri' }] },
        'preview_uri',
      ],
      [
        { ...validResponse, results: [{ ...validResponse.results[0], score: Number.NaN }] },
        'score',
      ],
      [
        { ...validResponse, results: [{ ...validResponse.results[0], evidence: [null] }] },
        'evidence[0] phải là object',
      ],
      [
        {
          ...validResponse,
          results: [{ ...validResponse.results[0], evidence: [{ type: 'unknown' }] }],
        },
        'type không hợp lệ',
      ],
      [
        {
          ...validResponse,
          results: [
            {
              ...validResponse.results[0],
              evidence: [{ type: 'ocr', evidence_id: 'ev', producer: 'ocr', start_ms: 20, end_ms: 10 }],
            },
          ],
        },
        'interval không hợp lệ',
      ],
      [
        { ...validResponse, results: [{ ...validResponse.results[0], representative_frame: 'bad' }] },
        'representative_frame',
      ],
      [
        { ...validResponse, results: [{ ...validResponse.results[0], matched_modalities: ['unknown'] }] },
        'matched_modalities',
      ],
      [
        { ...validResponse, results: [{ ...validResponse.results[0], matched_modalities: [1] }] },
        'matched_modalities phải là array text',
      ],
      [
        { ...validResponse, results: [{ ...validResponse.results[0], representative_frame: { original_frame_id: -1 } }] },
        'original_frame_id',
      ],
    ];

    for (const [value, message] of invalidCases) {
      expect(() => parseSearchResponse(value), message).toThrow(message);
    }

    expect(
      parseSearchResponse({ ...validResponse, results: [{ ...validResponse.results[0], evidence: 'legacy' }] })
        .results[0].evidence,
    ).toEqual([]);
  });

  it('sends the typed request without exposing an operator token to the browser', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(validResponse), { status: 200 }),
    );

    await searchMedia({ query: 'cửa hàng', task: 'textual_kis', top_k: 20 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/search',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it('maps the frontend Q&A task to the backend vqa task when saving selection', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        selection_id: 'selection_01',
        query_id: 'query_01',
        revision: 2,
        task: 'vqa',
        answers: [{ video_id: 'video_01', frame_id: 385, answer: 'Rẽ phải' }],
        note: null,
      }), { status: 200 }),
    );

    await saveSelection('query_01', 'qa', [{ video_id: 'video_01', frame_id: 385, answer: 'Rẽ phải' }]);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/queries/query_01/selection',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          task: 'vqa',
          answers: [{ video_id: 'video_01', frame_id: 385, answer: 'Rẽ phải' }],
        }),
      }),
    );
  });

  it('creates and validates a submission preview through the BFF', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        query_id: 'query_01',
        task: 'textual_kis',
        answer_count: 1,
        answers: [{ video_id: 'video_01', frame_id: 385 }],
        csv: 'video_01,385\r\n',
        submittable: false,
        warnings: ['preview_only'],
      }), { status: 200 }),
    );

    await expect(createSubmissionPreview(
      'query_01',
      'textual_kis',
      [{ video_id: 'video_01', frame_id: 385 }],
    )).resolves.toMatchObject({ answer_count: 1, submittable: false });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/submissions/preview');
  });

  it('handles empty tokens and API error envelopes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(validResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Token hết hạn.' }), { status: 401 }))
      .mockResolvedValueOnce(new Response('not-json', { status: 503 }));

    await searchMedia({ query: 'cảnh', task: 'textual_kis', top_k: 20 });
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ headers: { 'content-type': 'application/json' } }));

    await expect(searchMedia({ query: 'cảnh', task: 'textual_kis', top_k: 20 })).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      message: 'Token hết hạn.',
    });
    await expect(searchMedia({ query: 'cảnh', task: 'textual_kis', top_k: 20 })).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      message: 'Tìm kiếm thất bại.',
    });
  });

  it('loads and validates playback metadata and neighboring frames', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        video_id: 'video_01',
        playback_uri: '/api/v1/media/videos/video_01',
        duration_ms: 60_000,
        fps: 30,
        mime_type: 'video/mp4',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        video_id: 'video_01',
        center_frame_id: 385,
        frames: [{
          video_id: 'video_01',
          keyframe_no: 4,
          original_frame_id: 351,
          timestamp_ms: 11_733,
          thumbnail_uri: '/api/v1/media/keyframes/video_01/by-frame/351',
        }],
      }), { status: 200 }));

    await expect(getVideoPlayback('video_01', 385)).resolves.toMatchObject({ duration_ms: 60_000 });
    await expect(getVideoFrames('video_01', 385, 25)).resolves.toMatchObject({ center_frame_id: 385 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/videos/video_01/playback?frame_id=385');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/videos/video_01/frames?center_frame_id=385&limit=25');
  });

  it('passes a configurable frame step when loading a spaced nearby window', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      video_id: 'video_01',
      center_frame_id: 385,
      frames: [],
    }), { status: 200 })));

    await expect(getVideoFrames('video_01', 385, 6, 90)).resolves.toMatchObject({ center_frame_id: 385 });
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/videos/video_01/frames?center_frame_id=385&limit=6&frame_step=90',
      expect.anything(),
    );
  });

  it('loads and validates the video studio contract', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      video: {
        video_id: 'video_01',
        playback_uri: 'https://cdn.example/video.mp4?signature=x',
        duration_ms: 60_000,
        fps: 30,
        mime_type: 'video/mp4',
      },
      frames: [{
        video_id: 'video_01',
        keyframe_no: 4,
        original_frame_id: 385,
        timestamp_ms: 12_800,
        captions: [{ evidence_id: 'caption-1', text: 'A shop', language: 'en', producer: 'caption:v1' }],
        objects: [{
          evidence_id: 'object-1', label: 'person', confidence: 0.9,
          normalized_bbox: [0.1, 0.2, 0.5, 0.9], producer: 'object:v1',
        }],
      }],
      asr_spans: [{
        evidence_id: 'asr-1', start_ms: 12_000, end_ms: 14_000,
        text: 'Xin chào', language: 'vi', producer: 'asr:v1',
      }],
    }), { status: 200 }));

    const studio = await getVideoStudio('video_01');

    expect(studio.frames[0]).toMatchObject({
      original_frame_id: 385,
      captions: [{ text: 'A shop' }],
      objects: [{ normalized_bbox: [0.1, 0.2, 0.5, 0.9] }],
    });
    expect(studio.asr_spans[0]).toMatchObject({ text: 'Xin chào', start_ms: 12_000 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/videos/video_01/studio');

    expect(() => parseVideoStudioResponse({
      video: studio.video,
      frames: [{ ...studio.frames[0], objects: [{ ...studio.frames[0].objects[0], normalized_bbox: [0, 0, 2, 1] }] }],
      asr_spans: studio.asr_spans,
    })).toThrow('normalized_bbox');
  });

  it('loads and validates an exact canonical frame contract', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      video_id: 'video_01',
      keyframe_no: null,
      original_frame_id: 386,
      timestamp_ms: 12_867,
      thumbnail_uri: '/api/v1/media/videos/video_01/frames/386/thumbnail',
      is_exact_frame: true,
      annotation_source_frame_id: 385,
      captions: [],
      objects: [],
    }), { status: 200 }));

    await expect(getVideoFrame('video_01', 386)).resolves.toMatchObject({
      original_frame_id: 386,
      is_exact_frame: true,
      annotation_source_frame_id: 385,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/media/videos/video_01/frames/386', { signal: undefined });
  });

  it('falls back to the exact-frame thumbnail endpoint when an original frame is not a keyframe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      video_id: 'video_01',
      keyframe_no: null,
      original_frame_id: 386,
      timestamp_ms: 12_867,
      thumbnail_uri: null,
      is_exact_frame: true,
      annotation_source_frame_id: 385,
      captions: [],
      objects: [],
    }), { status: 200 }));

    await expect(getVideoFrame('video_01', 386)).resolves.toMatchObject({
      original_frame_id: 386,
      thumbnail_uri: '/api/v1/media/videos/video_01/frames/386/thumbnail',
      is_exact_frame: true,
    });
  });

  it('rejects malformed playback and frame-context responses', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ video_id: 'video_01' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ video_id: 'video_01', center_frame_id: -1, frames: [] }), { status: 200 }));

    await expect(getVideoPlayback('video_01', 385)).rejects.toThrow('playback_uri');
    await expect(getVideoFrames('video_01', 385, 25)).rejects.toThrow('center_frame_id');
  });
});
