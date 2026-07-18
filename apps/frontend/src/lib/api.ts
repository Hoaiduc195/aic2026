import type { SearchRequest, SearchResponse } from './contracts';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

export async function searchMedia(request: SearchRequest): Promise<SearchResponse> {
  const response = await fetch(`${API_BASE}/v1/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const message = response.status >= 500
      ? 'Search is temporarily unavailable.'
      : 'Search request was rejected.';
    throw new Error(message);
  }
  return response.json() as Promise<SearchResponse>;
}
