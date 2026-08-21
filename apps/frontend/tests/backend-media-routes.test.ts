import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as getKeyframe } from '@/app/api/v1/media/keyframes/[videoId]/by-frame/[frameId]/route';
import { GET as getExactFrame } from '@/app/api/v1/media/videos/[videoId]/frames/[frameId]/route';
import { GET as getExactFrameThumbnail } from '@/app/api/v1/media/videos/[videoId]/frames/[frameId]/thumbnail/route';
import { GET as getFrames } from '@/app/api/v1/videos/[videoId]/frames/route';
import { GET as getPlayback } from '@/app/api/v1/videos/[videoId]/playback/route';
import { GET as getStudio } from '@/app/api/v1/videos/[videoId]/studio/route';

afterEach(() => {
  delete process.env.BACKEND_API_URL;
  delete process.env.BACKEND_OPERATOR_TOKEN;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('backend-backed media routes', () => {
  it('proxies playback metadata with the server-side token', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    process.env.BACKEND_OPERATOR_TOKEN = 'server-only-secret';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-operator-token')).toBe('server-only-secret');
      return new Response(JSON.stringify({
        video_id: 'video_01',
        playback_uri: 'https://r2.example/video.mp4?signature=x',
        duration_ms: 60_000,
        fps: 30,
        mime_type: 'video/mp4',
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await getPlayback(
      new NextRequest('http://localhost/api/v1/videos/video_01/playback?frame_id=385'),
      { params: Promise.resolve({ videoId: 'video_01' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ playback_uri: expect.stringContaining('https://') });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.internal/v1/videos/video_01/playback?frame_id=385',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('proxies frame context and preserves signed thumbnail URLs', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal/';
    process.env.BACKEND_OPERATOR_TOKEN = 'server-only-secret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      video_id: 'video_01',
      center_frame_id: 385,
      frames: [{
        video_id: 'video_01',
        keyframe_no: 4,
        original_frame_id: 385,
        timestamp_ms: 12_800,
        thumbnail_uri: 'https://r2.example/frame.jpg?signature=x',
      }],
    }), { status: 200 })));

    const response = await getFrames(
      new NextRequest('http://localhost/api/v1/videos/video_01/frames?center_frame_id=385&limit=25'),
      { params: Promise.resolve({ videoId: 'video_01' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ frames: [{ thumbnail_uri: expect.stringContaining('https://') }] });
  });

  it('proxies studio metadata with video signing data but no eager thumbnails', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    process.env.BACKEND_OPERATOR_TOKEN = 'server-only-secret';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-operator-token')).toBe('server-only-secret');
      return new Response(JSON.stringify({
        video: {
          video_id: 'video_01',
          playback_uri: 'https://r2.example/video.mp4?signature=x',
          duration_ms: 60_000,
          fps: 30,
          mime_type: 'video/mp4',
        },
        frames: [{
          video_id: 'video_01', keyframe_no: 4, original_frame_id: 385,
          timestamp_ms: 12_800, captions: [], objects: [],
        }],
        asr_spans: [],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await getStudio(
      new NextRequest('http://localhost/api/v1/videos/video_01/studio'),
      { params: Promise.resolve({ videoId: 'video_01' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      video: { video_id: 'video_01' },
      frames: [{ original_frame_id: 385 }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.internal/v1/videos/video_01/studio',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('resolves a backend frame into a redirect instead of reading local media', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    process.env.BACKEND_OPERATOR_TOKEN = 'server-only-secret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      video_id: 'video_01',
      center_frame_id: 385,
      frames: [{
        video_id: 'video_01',
        keyframe_no: 4,
        original_frame_id: 385,
        timestamp_ms: 12_800,
        thumbnail_uri: 'https://r2.example/frame.jpg?signature=x',
      }],
    }), { status: 200 })));

    const response = await getKeyframe(
      new NextRequest('http://localhost/api/v1/media/keyframes/video_01/by-frame/385'),
      { params: Promise.resolve({ videoId: 'video_01', frameId: '385' }) },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://r2.example/frame.jpg?signature=x');
  });

  it('proxies exact frame metadata and rewrites its thumbnail through the frontend', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    process.env.BACKEND_OPERATOR_TOKEN = 'server-only-secret';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
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
    vi.stubGlobal('fetch', fetchMock);

    const response = await getExactFrame(
      new NextRequest('http://localhost/api/v1/media/videos/video_01/frames/386'),
      { params: Promise.resolve({ videoId: 'video_01', frameId: '386' }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      original_frame_id: 386,
      thumbnail_uri: '/api/v1/media/videos/video_01/frames/386/thumbnail',
    });
    expect(fetchMock).toHaveBeenCalledWith('http://backend.internal/v1/videos/video_01/frames/386', expect.any(Object));
  });

  it('streams exact frame thumbnails without exposing the backend URL', async () => {
    process.env.BACKEND_API_URL = 'http://backend.internal';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })));

    const response = await getExactFrameThumbnail(
      new NextRequest('http://localhost/api/v1/media/videos/video_01/frames/386/thumbnail'),
      { params: Promise.resolve({ videoId: 'video_01', frameId: '386' }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/jpeg');
    const bytes = await response.arrayBuffer();
    expect(bytes.byteLength).toBe(3);
  });
});
