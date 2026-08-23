import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as getCandidates } from '@/app/api/v1/queries/[queryId]/candidates/route';
import { GET as getSelection, PUT as putSelection } from '@/app/api/v1/queries/[queryId]/selection/route';
import { POST as searchExactFrames } from '@/app/api/v1/search/exact-frames/route';
import { POST as createPreview } from '@/app/api/v1/submissions/preview/route';
import { GET as getVideoKeyframe } from '@/app/api/v1/videos/[videoId]/keyframes/[keyframeNo]/route';

afterEach(() => {
  delete process.env.BACKEND_API_URL;
  delete process.env.BACKEND_OPERATOR_TOKEN;
  delete process.env.AIC_ALLOW_UNAUTHENTICATED_MEDIA;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('manual BFF routes', () => {
  it('proxies candidate pagination and keeps the backend token server-side', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    process.env.BACKEND_OPERATOR_TOKEN = 'server-only-secret';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-operator-token')).toBe('server-only-secret');
      return new Response(JSON.stringify({ query_id: 'query_01', total: 1, limit: 25, offset: 10, candidates: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await getCandidates(
      new NextRequest('http://localhost/api/v1/queries/query_01/candidates?limit=25&offset=10'),
      { params: Promise.resolve({ queryId: 'query_01' }) },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.internal/v1/queries/query_01/candidates?limit=25&offset=10',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('forwards selection writes and supports latest selection reads', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    process.env.BACKEND_OPERATOR_TOKEN = 'server-only-secret';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toMatchObject({ task: 'vqa' });
        return new Response(JSON.stringify({ revision: 2 }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: 2 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const putResponse = await putSelection(
      new NextRequest('http://localhost/api/v1/queries/query_01/selection', {
        method: 'PUT',
        body: JSON.stringify({ task: 'vqa', answers: [{ video_id: 'video_01', frame_id: 385, answer: 'Rẽ phải' }] }),
      }),
      { params: Promise.resolve({ queryId: 'query_01' }) },
    );
    const getResponse = await getSelection(
      new NextRequest('http://localhost/api/v1/queries/query_01/selection'),
      { params: Promise.resolve({ queryId: 'query_01' }) },
    );

    expect(putResponse.status).toBe(200);
    expect(getResponse.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed preview payloads before contacting the backend', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await createPreview(new NextRequest('http://localhost/api/v1/submissions/preview', {
      method: 'POST',
      body: JSON.stringify({ query_id: 'query_01', task: 'vqa', answers: [] }),
    }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates and proxies an exact-frame batch request', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    process.env.BACKEND_OPERATOR_TOKEN = 'server-only-secret';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-operator-token')).toBe('server-only-secret');
      expect(JSON.parse(String(init?.body))).toEqual({
        task: 'textual_kis',
        frames: [{ video_id: 'video_01', original_frame_id: 385 }],
        session_id: 'session_01',
      });
      return new Response(JSON.stringify({ query_id: 'query_01', results: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await searchExactFrames(new NextRequest('http://localhost/api/v1/search/exact-frames', {
      method: 'POST',
      body: JSON.stringify({
        task: 'textual_kis',
        frames: [{ video_id: 'video_01', original_frame_id: 385 }],
        session_id: 'session_01',
      }),
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves a keyframe ordinal through the protected media BFF route', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    process.env.AIC_ALLOW_UNAUTHENTICATED_MEDIA = 'true';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      video_id: 'video_01',
      keyframe_no: 7,
      original_frame_id: 385,
      timestamp_ms: 12_833,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await getVideoKeyframe(
      new NextRequest('http://localhost/api/v1/videos/video_01/keyframes/7'),
      { params: Promise.resolve({ videoId: 'video_01', keyframeNo: '7' }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      original_frame_id: 385,
      thumbnail_uri: '/api/v1/media/videos/video_01/frames/385/thumbnail',
    });
  });
});
