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
});
