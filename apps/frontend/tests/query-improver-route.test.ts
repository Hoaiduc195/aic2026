import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { POST } from '@/app/api/v1/query/improve/route';

afterEach(() => {
  delete process.env.BACKEND_API_URL;
  delete process.env.BACKEND_OPERATOR_TOKEN;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('query improver proxy route', () => {
  it('forwards a valid request and keeps the LLM config request-scoped', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    process.env.BACKEND_OPERATOR_TOKEN = 'server-only-secret';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-operator-token')).toBe('server-only-secret');
      return new Response(JSON.stringify({
        original_query: 'một người đi bộ', improved_query: 'A person walking.', changed: true,
        producer: 'test', model_version: 'model', warning: null,
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(new NextRequest('http://localhost/api/v1/query/improve', {
      method: 'POST',
      body: JSON.stringify({
        query: 'một người đi bộ', task: 'textual_kis',
        llm: {
          base_url: 'http://localhost:20128/v1', api_key: 'request-secret', model: 'query-model',
          timeout_ms: 5000, max_tokens: 128, temperature: 0,
        },
      }),
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('http://backend.internal/v1/query/improve', expect.anything());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      query: 'một người đi bộ', task: 'textual_kis', llm: { model: 'query-model' },
    });
  });

  it('forwards the separate Q&A question to the backend improver', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      original_query: 'Một cửa hàng trên phố', improved_query: 'A shop on a street.',
      original_question: 'Người phụ nữ đang cầm gì?', improved_question: 'What is the woman holding?',
      changed: true, producer: 'test', model_version: 'model', warning: null,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(new NextRequest('http://localhost/api/v1/query/improve', {
      method: 'POST',
      body: JSON.stringify({
        query: 'Một cửa hàng trên phố', question: 'Người phụ nữ đang cầm gì?', task: 'vqa',
      }),
    }));

    expect(response.status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      query: 'Một cửa hàng trên phố', question: 'Người phụ nữ đang cầm gì?', task: 'vqa',
    });
  });

  it('forwards the TRAKE overview and events as separate fields', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      original_query: 'Một người đi qua cửa hàng rồi rời đi',
      improved_query: 'A person crosses a shop and then leaves',
      original_events: ['Người bước vào cửa hàng', 'Người rời khỏi cửa hàng'],
      improved_events: ['The person enters the shop', 'The person leaves the shop'],
      changed: true, producer: 'test', model_version: 'model', warning: null,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(new NextRequest('http://localhost/api/v1/query/improve', {
      method: 'POST',
      body: JSON.stringify({
        query: 'Một người đi qua cửa hàng rồi rời đi',
        events: ['Người bước vào cửa hàng', 'Người rời khỏi cửa hàng'],
        task: 'trake',
      }),
    }));

    expect(response.status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      query: 'Một người đi qua cửa hàng rồi rời đi',
      events: ['Người bước vào cửa hàng', 'Người rời khỏi cửa hàng'],
      task: 'trake',
    });
  });

  it('rejects an unsafe model endpoint before contacting backend', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(new NextRequest('http://localhost/api/v1/query/improve', {
      method: 'POST',
      body: JSON.stringify({
        query: 'query', task: 'textual_kis',
        llm: { base_url: 'ftp://unsafe.test/v1', model: 'm', timeout_ms: 1000, max_tokens: 10, temperature: 0 },
      }),
    }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
