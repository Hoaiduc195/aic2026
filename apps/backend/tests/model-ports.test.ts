import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpQueryEmbeddingProvider, UnavailableQueryEmbeddingProvider } from '../src/compute/model-ports';

afterEach(() => vi.restoreAllMocks());

describe('query embedding providers', () => {
  it('calls an external encoder with optional bearer auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 })));
    const provider = new HttpQueryEmbeddingProvider('https://encoder.test/embed', 2, 'secret');
    await expect(provider.embedText('a bike')).resolves.toEqual([0.1, 0.2]);
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ authorization: 'Bearer secret' });
  });

  it('rejects failed or malformed encoder responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
    await expect(new HttpQueryEmbeddingProvider('https://encoder.test', 2).embedText('x')).rejects.toThrow('HTTP 502');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ embedding: [Number.NaN] }))));
    await expect(new HttpQueryEmbeddingProvider('https://encoder.test', 2).embedText('x')).rejects.toThrow('2 finite');
    await expect(new UnavailableQueryEmbeddingProvider().embedText('x')).rejects.toThrow('not configured');
  });
});
