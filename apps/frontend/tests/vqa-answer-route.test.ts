import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { POST } from '@/app/api/v1/vqa/answer/route';

afterEach(() => {
  delete process.env.BACKEND_API_URL;
  delete process.env.BACKEND_OPERATOR_TOKEN;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('VQA answer proxy route', () => {
  it('forwards a valid request using the server-side operator token', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    process.env.BACKEND_OPERATOR_TOKEN = 'server-only-secret';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-operator-token')).toBe('server-only-secret');
      return new Response(JSON.stringify({ answer_status: 'answered', answer: 'một chiếc chai' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(new NextRequest('http://localhost/api/v1/vqa/answer', {
      method: 'POST',
      body: JSON.stringify({
        query_id: 'query-1', question: 'Đang cầm gì?', video_id: 'video-1', original_frame_id: 42,
        llm: {
          base_url: 'https://llm.test/v1', api_key: 'request-secret', model: 'custom-v1',
          timeout_ms: 2500, max_tokens: 64, temperature: 0.2,
        },
      }),
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('http://backend.internal/v1/vqa/answer', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body.llm).toMatchObject({ base_url: 'https://llm.test/v1', model: 'custom-v1', max_tokens: 64 });
  });

  it('rejects malformed requests before contacting the backend', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(new NextRequest('http://localhost/api/v1/vqa/answer', {
      method: 'POST', body: JSON.stringify({ query_id: 'bad id' }),
    }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unsafe frontend LLM endpoint before contacting the backend', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(new NextRequest('http://localhost/api/v1/vqa/answer', {
      method: 'POST',
      body: JSON.stringify({
        query_id: 'query-1', question: 'Đang cầm gì?', video_id: 'video-1', original_frame_id: 42,
        llm: { base_url: 'ftp://unsafe.test/v1', model: 'custom-v1' },
      }),
    }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
