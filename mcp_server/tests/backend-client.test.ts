import { describe, expect, it, vi } from 'vitest';

import { BackendClient } from '../src/backend-client.js';

describe('BackendClient', () => {
  it('posts a text search to the existing retrieval endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ query_id: 'q-1', results: [] }), { status: 200 }));
    const client = new BackendClient({
      baseUrl: 'http://localhost:4000',
      fetcher,
      timeoutMs: 1000,
      operatorToken: 'secret',
    });

    await client.searchFrames({ query: 'người cầm ô', task: 'vqa', topK: 5 });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('http://localhost:4000/v1/search');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-operator-token')).toBe('secret');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ query: 'người cầm ô', task: 'vqa', top_k: 5 });
    expect(body).not.toHaveProperty('embedding');
  });

  it('forwards the MCP embedding service configuration to text searches', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ query_id: 'q-embedding', results: [] }), { status: 200 }));
    const client = new BackendClient({
      baseUrl: 'http://localhost:4000',
      fetcher,
      timeoutMs: 1000,
      embedding: {
        baseUrl: 'http://127.0.0.1:8001/embed',
        apiKey: 'embedding-token',
        timeoutMs: 2500,
      },
    });

    await client.searchFrames({ query: 'sạt lở', task: 'textual_kis', topK: 5 });

    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
      embedding: {
        base_url: 'http://127.0.0.1:8001/embed',
        api_key: 'embedding-token',
        timeout_ms: 2500,
      },
    });
  });

  it('resolves a keyframe before downloading its exact image', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        video_id: 'v',
        original_frame_id: 42,
        keyframe_no: 7,
        timestamp_ms: 1000,
        captions: [],
        ocr: [],
        objects: [],
        thumbnail_uri: 'http://signed/frame.jpg',
        is_exact_frame: true,
        annotation_source_frame_id: null,
        asr_spans: [],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([255, 216, 255]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }));
    const client = new BackendClient({
      baseUrl: 'http://localhost:4000',
      fetcher,
      timeoutMs: 1000,
    });

    const result = await client.getFrameImage({ videoId: 'v', keyframeNo: 7 });

    expect(result.mimeType).toBe('image/jpeg');
    expect(result.bytes).toEqual(Buffer.from([255, 216, 255]));
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:4000/v1/videos/v/keyframes/7',
      'http://localhost:4000/v1/videos/v/frames/42/thumbnail',
    ]);
  });

  it('omits embedding from planning requests when the MCP service is not configured', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      query_id: 'plan-no-embedding', task: 'trake', language: 'en', original_query: 'main', query_variants: ['main'], concepts: [], query_atoms: [],
      negative_concepts: [], text_constraints: [], audio_concepts: [], object_terms: [], object_constraints: {}, query_views: {}, channel_weights: {},
      temporal_relations: [], target_granularities: ['frame'], branches: ['caption'], top_k_per_branch: 10, fusion_k: 10, display_k: 10,
      rrf_k: 60, latency_budget_ms: 5000, fallback_policy: 'expand_then_abstain', planner_version: 'test', fusion: 'rrf', index_version: 'idx', hard_filters: {}, transformations: [],
    }), { status: 200 }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4000', fetcher, timeoutMs: 1000 });

    await client.planSearch({ query: 'main', task: 'trake', topK: 4 });

    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty('embedding');
  });

  it('supports exact-frame search, ordinary frames, nearby frames, video and studio metadata', async () => {
    const frame = {
      video_id: 'v', keyframe_no: 2, original_frame_id: 42, timestamp_ms: 1000,
      captions: [], ocr: [], objects: [], thumbnail_uri: 'http://signed/frame.jpg',
      is_exact_frame: true, annotation_source_frame_id: null, asr_spans: [],
    };
    const playback = { video_id: 'v', playback_uri: 'http://signed/video.mp4', duration_ms: 1000, fps: 25, mime_type: 'video/mp4' };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/search')) return new Response(JSON.stringify({ query_id: 'visual', warnings: [], results: [] }), { status: 200 });
      if (url.endsWith('/search/exact-frames')) return new Response(JSON.stringify({ query_id: 'exact', warnings: [], results: [] }), { status: 200 });
      if (url.endsWith('/videos/v/keyframes/2')) return new Response(JSON.stringify(frame), { status: 200 });
      if (url.endsWith('/videos/v/frames/42')) return new Response(JSON.stringify(frame), { status: 200 });
      if (url.includes('/videos/v/frames?')) return new Response(JSON.stringify({ video_id: 'v', center_frame_id: 42, frames: [{ ...frame, thumbnail_uri: 'http://signed/frame.jpg' }] }), { status: 200 });
      if (url.endsWith('/videos/v/playback')) return new Response(JSON.stringify(playback), { status: 200 });
      if (url.endsWith('/videos/v/studio')) return new Response(JSON.stringify({ video: playback, frames: [], asr_spans: [] }), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    });
    const client = new BackendClient({ baseUrl: 'http://localhost:4000', fetcher, timeoutMs: 1000 });

    await client.searchFrames({ query: '', task: 'vqa', topK: 1, frameQuery: { videoId: 'v', keyframeNo: 2 } });
    await client.searchExactFrames({ task: 'trake', frames: [{ videoId: 'v', originalFrameId: 42 }, { videoId: 'v', keyframeNo: 2 }] });
    expect((await client.getFrame({ videoId: 'v', originalFrameId: 42 })).original_frame_id).toBe(42);
    expect((await client.getNearbyFrames('v', 42, 3)).frames).toHaveLength(1);
    expect((await client.getVideo('v')).video_id).toBe('v');
    expect((await client.getStudio('v')).video.video_id).toBe('v');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('session_id') || String(url).includes('top_k'))).toBe(false);
  });

  it('uses the read-only planning, VQA, candidate, preview and health endpoints', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/search/plan')) return new Response(JSON.stringify({
        query_id: 'plan-1', task: 'trake', language: 'en', original_query: 'main', query_variants: ['main'], concepts: [], query_atoms: [],
        negative_concepts: [], text_constraints: [], audio_concepts: [], object_terms: [], object_constraints: {}, query_views: {}, channel_weights: {},
        temporal_relations: [], target_granularities: ['frame'], branches: ['caption'], top_k_per_branch: 10, fusion_k: 10, display_k: 10,
        rrf_k: 60, latency_budget_ms: 5000, fallback_policy: 'expand_then_abstain', planner_version: 'test', fusion: 'rrf', index_version: 'idx', hard_filters: {}, transformations: [],
      }), { status: 200 });
      if (url.endsWith('/v1/vqa/answer')) return new Response(JSON.stringify({
        result_id: 'answer-1', query_id: 'query-1', video_id: 'v-1', original_frame_id: 4, timestamp_ms: 100,
        answer_status: 'answered', answer: 'ô', normalized_answer: 'ô', evidence_ids: [], confidence: { level: 'high', score: 0.9 }, producer: 'test', model_version: 'test', verification: {},
      }), { status: 200 });
      if (url.includes('/v1/queries/q-1/candidates')) return new Response(JSON.stringify({ query_id: 'q-1', total: 0, limit: 10, offset: 0, candidates: [] }), { status: 200 });
      if (url.endsWith('/v1/queries/q-1/selection')) return new Response('null', { status: 200 });
      if (url.endsWith('/v1/submissions/preview')) return new Response(JSON.stringify({ query_id: 'q-1', task: 'vqa', answer_count: 1, answers: [{ video_id: 'v-1', frame_id: 4, answer: 'ô' }], csv: 'v-1,4,ô\r\n', submittable: false, warnings: [] }), { status: 200 });
      if (url.endsWith('/health')) return new Response(JSON.stringify({ status: 'ok', service: 'backend', mode: 'offline-first', dependencies: {}, retrieval_branches: [], task_executors: [] }), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    });
    const client = new BackendClient({
      baseUrl: 'http://localhost:4000',
      fetcher,
      timeoutMs: 1000,
      embedding: { baseUrl: 'http://127.0.0.1:8001/embed', timeoutMs: 2500 },
    });

    await client.planSearch({ query: 'main', task: 'trake', topK: 4 });
    await client.getVqaAnswer({ queryId: 'query-1', question: 'Đang cầm gì?', frame: { videoId: 'v-1', originalFrameId: 4 } });
    await client.getCandidates({ queryId: 'q-1', limit: 10, offset: 0 });
    expect(await client.getSelection('q-1')).toBeNull();
    await client.previewSubmission({ queryId: 'q-1', task: 'vqa', answers: [{ videoId: 'v-1', frameId: 4, answer: 'ô' }] });
    await client.getHealth();

    const planBody = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    const previewBody = JSON.parse(String(fetcher.mock.calls[4][1]?.body));
    expect(planBody).toMatchObject({ query: 'main', task: 'trake', top_k: 4 });
    expect(planBody).toMatchObject({
      embedding: { base_url: 'http://127.0.0.1:8001/embed', timeout_ms: 2500 },
    });
    expect(previewBody).toMatchObject({ query_id: 'q-1', task: 'vqa', answers: [{ video_id: 'v-1', frame_id: 4, answer: 'ô' }] });
  });

  it('rejects oversized and unsupported image responses', async () => {
    const frame = JSON.stringify({ video_id: 'v', keyframe_no: null, original_frame_id: 1, timestamp_ms: 0, captions: [], ocr: [], objects: [], thumbnail_uri: null, is_exact_frame: true, annotation_source_frame_id: null, asr_spans: [] });
    const oversized = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(frame, { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '20' },
      }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4000', fetcher: oversized, timeoutMs: 1000, maxImageBytes: 10 });
    await expect(client.getFrameImage({ videoId: 'v', originalFrameId: 1 })).rejects.toThrow('frame image exceeds configured size limit');

    const unsupported = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(frame, { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }));
    const unsupportedClient = new BackendClient({ baseUrl: 'http://localhost:4000', fetcher: unsupported, timeoutMs: 1000 });
    await expect(unsupportedClient.getFrameImage({ videoId: 'v', originalFrameId: 1 })).rejects.toThrow('unsupported image type');
  });

  it('turns non-success backend responses into safe errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: 'operator token is required' }), { status: 401 }));
    const client = new BackendClient({ baseUrl: 'http://localhost:4000', fetcher, timeoutMs: 1000 });

    await expect(client.getVideo('v')).rejects.toThrow('Backend request failed (401)');
  });
});
