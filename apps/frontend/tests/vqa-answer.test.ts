import { afterEach, describe, expect, it, vi } from 'vitest';

import { suggestVqaAnswer } from '@/lib/api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('VQA answer API client', () => {
  it('posts the selected frame request and parses the grounded answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      result_id: 'result-1', query_id: 'query-1', video_id: 'video-1', original_frame_id: 42,
      timestamp_ms: 4200, answer_status: 'answered', answer: 'một chiếc chai', normalized_answer: 'một chiếc chai',
      evidence_ids: ['caption-1'], confidence: { level: 'high', score: 0.9 }, producer: 'llm-vqa',
      model_version: 'aic-qa-v1',
    }), { status: 200 })));

    await expect(suggestVqaAnswer({
      query_id: 'query-1', question: 'Người phụ nữ đang cầm vật gì?', video_id: 'video-1', original_frame_id: 42,
    })).resolves.toMatchObject({ answer: 'một chiếc chai', answer_status: 'answered' });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/v1/vqa/answer');
    expect(JSON.parse(String(init?.body))).toMatchObject({ query_id: 'query-1', original_frame_id: 42 });
  });
});
