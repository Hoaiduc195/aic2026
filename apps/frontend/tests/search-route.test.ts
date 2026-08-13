import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { POST } from '@/app/api/v1/search/route';

afterEach(() => {
  delete process.env.AIC_MEDIA_ACCESS_TOKEN;
  delete process.env.BACKEND_API_URL;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('search proxy route', () => {
  it('does not reflect internal upstream error messages to the browser', async () => {
    process.env.AIC_MEDIA_ACCESS_TOKEN = 'test-operator-secret';
    process.env.BACKEND_API_URL = 'http://backend.internal';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'postgres host=db.internal password=leaked' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )));

    const request = new NextRequest('http://localhost/api/v1/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-operator-token': 'test-operator-secret',
      },
      body: JSON.stringify({ query: 'cửa hàng', task: 'textual_kis', top_k: 20 }),
    });
    const response = await POST(request);
    const payload = await response.json() as { message: string };

    expect(response.status).toBe(500);
    expect(payload.message).toBe('Backend tìm kiếm không thể xử lý yêu cầu.');
    expect(payload.message).not.toContain('postgres');
  });
});
