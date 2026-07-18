import { afterEach, describe, expect, it, vi } from 'vitest';

import { searchMedia } from './api';

describe('searchMedia', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the strict search envelope and returns JSON', async () => {
    const payload = { request_id: 'req-1' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchMedia({ query: 'xin chào', task: 'textual_kis', top_k: 20 })).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/search'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ query: 'xin chào', task: 'textual_kis', top_k: 20 }) }),
    );
  });

  it.each([
    [400, 'Search request was rejected.'],
    [503, 'Search is temporarily unavailable.'],
  ])('sanitizes HTTP %s failures', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));
    await expect(searchMedia({ query: 'q', task: 'textual_kis', top_k: 1 })).rejects.toThrow(message);
  });
});
