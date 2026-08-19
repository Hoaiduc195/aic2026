import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { POST } from '@/app/api/v1/search/route';

afterEach(() => {
  delete process.env.AIC_MEDIA_ACCESS_TOKEN;
  delete process.env.BACKEND_API_URL;
  delete process.env.BACKEND_OPERATOR_TOKEN;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('search proxy route', () => {
  it('does not reflect internal upstream error messages to the browser', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'postgres host=db.internal password=leaked' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )));

    const request = new NextRequest('http://localhost/api/v1/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: 'cửa hàng', task: 'textual_kis', top_k: 20 }),
    });
    const response = await POST(request);
    const payload = await response.json() as { message: string };

    expect(response.status).toBe(500);
    expect(payload.message).toBe('Backend tìm kiếm không thể xử lý yêu cầu.');
    expect(payload.message).not.toContain('postgres');
  });

  it('uses the server-side backend token instead of a browser token', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    process.env.BACKEND_OPERATOR_TOKEN = 'server-only-secret';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-operator-token')).toBe('server-only-secret');
      return new Response(JSON.stringify({
        query_id: 'query_01',
        results: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const request = new NextRequest('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'cửa hàng', task: 'textual_kis', top_k: 20 }),
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns a safe 502 when the backend cannot be reached', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket details'); }));

    const request = new NextRequest('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'cửa hàng', task: 'textual_kis', top_k: 20 }),
    });
    const response = await POST(request);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ message: 'Không thể kết nối tới backend tìm kiếm.' });
  });

  it('forwards a validated per-request embedding override without replacing the server backend token', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    process.env.BACKEND_OPERATOR_TOKEN = 'server-only-secret';
    let forwardedBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-operator-token')).toBe('server-only-secret');
      forwardedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ query_id: 'query_01', results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const request = new NextRequest('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'cửa hàng',
        task: 'textual_kis',
        top_k: 20,
        embedding: {
          base_url: 'http://127.0.0.1:8001/embed',
          api_key: 'browser-tab-secret',
          timeout_ms: 2500,
        },
      }),
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(forwardedBody).toMatchObject({
      embedding: {
        base_url: 'http://127.0.0.1:8001/embed',
        api_key: 'browser-tab-secret',
        timeout_ms: 2500,
      },
    });
  });

  it('forwards validated retrieval limits and uses display_k as the public top_k', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    let forwardedBody: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ query_id: 'query_01', results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const request = new NextRequest('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'cửa hàng',
        task: 'textual_kis',
        top_k: 20,
        retrieval: {
          display_k: 40,
          branch_k: 150,
          fusion_k: 600,
          rrf_k: 30,
          channel_weights: { clip: 1.4, object: 0.5 },
          vlm_rerank: { enabled: true, top_k: 10, weight: 0.7 },
        },
      }),
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(forwardedBody).toMatchObject({
      top_k: 40,
      retrieval: {
        display_k: 40,
        branch_k: 150,
        fusion_k: 600,
        rrf_k: 30,
        channel_weights: { clip: 1.4, object: 0.5 },
        vlm_rerank: { enabled: true, top_k: 10, weight: 0.7 },
      },
    });
  });

  it('forwards an empty image query only with a validated exact frame identity', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    let forwardedBody: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ query_id: 'query_01', results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const request = new NextRequest('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: '',
        task: 'textual_kis',
        top_k: 20,
        frame_query: { video_id: 'video_01', original_frame_id: 385 },
      }),
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(forwardedBody).toMatchObject({
      query: '',
      frame_query: { video_id: 'video_01', original_frame_id: 385 },
    });
  });

  it('rejects frame identities that could escape the media namespace', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const request = new NextRequest('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: '',
        task: 'textual_kis',
        frame_query: { video_id: '../private', original_frame_id: 1 },
      }),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects retrieval limits outside the frontend safety boundary', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const request = new NextRequest('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'cửa hàng',
        task: 'textual_kis',
        retrieval: { display_k: 101, branch_k: 150, fusion_k: 600 },
      }),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsafe embedding URLs at the BFF boundary', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const request = new NextRequest('http://localhost/api/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'cửa hàng',
        task: 'textual_kis',
        embedding: { base_url: 'ftp://embedding.local/embed', timeout_ms: 2500 },
      }),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
