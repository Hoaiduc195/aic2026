import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchImageAsDataUrl } from '../src/compute/image-data-url';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('image data URL loader', () => {
  it('downloads a supported image and converts it to a data URL', async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe('https://signed.test/keyframes/video-1/42.jpg');
      expect(init?.redirect).toBe('error');
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }));

    await expect(fetchImageAsDataUrl('https://signed.test/keyframes/video-1/42.jpg'))
      .resolves.toBe(`data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`);
  });

  it('detects an image when object storage reports octet-stream', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, {
      status: 200, headers: { 'content-type': 'application/octet-stream' },
    })));

    await expect(fetchImageAsDataUrl('https://signed.test/frame'))
      .resolves.toBe(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
  });

  it('rejects failed, non-image, and oversized responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(fetchImageAsDataUrl('https://signed.test/missing')).rejects.toThrow('HTTP 404');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('html', {
      status: 200, headers: { 'content-type': 'text/html' },
    })));
    await expect(fetchImageAsDataUrl('https://signed.test/html')).rejects.toThrow('supported image');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.from([1, 2, 3]), {
      status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
    })));
    await expect(fetchImageAsDataUrl('https://signed.test/large', { maxBytes: 2 }))
      .rejects.toThrow('maximum size');
  });
});
