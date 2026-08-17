import { NextRequest, NextResponse } from 'next/server';

import { forwardJsonResponse, requestBackend } from '../../../../lib/backend-proxy';
import { mockSearchResponse } from '../../../../lib/mock-data';
import type { SearchEmbeddingConfig, SearchRequest, SearchRetrievalConfig } from '../../../../lib/contracts';
import { attachMediaSession } from '../../../../lib/server-media-access';

const SEARCH_TASKS = new Set<SearchRequest['task']>(['textual_kis', 'video_kis', 'avs', 'vqa', 'trake', 'kisc']);

function normalizeEmbedding(value: unknown): SearchEmbeddingConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('embedding must be an object');
  const input = value as Record<string, unknown>;
  if (typeof input.base_url !== 'string' || !input.base_url.trim() || input.base_url.trim().length > 2000) {
    throw new Error('embedding URL is invalid');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(input.base_url.trim());
  } catch {
    throw new Error('embedding URL is invalid');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('embedding URL is invalid');
  }
  if (!Number.isSafeInteger(input.timeout_ms) || (input.timeout_ms as number) < 100 || (input.timeout_ms as number) > 120_000) {
    throw new Error('embedding timeout is invalid');
  }
  if (input.api_key !== undefined && (typeof input.api_key !== 'string' || input.api_key.length > 1000)) {
    throw new Error('embedding token is invalid');
  }
  const apiKey = typeof input.api_key === 'string' ? input.api_key.trim() : '';
  return {
    base_url: endpoint.toString().replace(/\/+$/, ''),
    ...(apiKey ? { api_key: apiKey } : {}),
    timeout_ms: input.timeout_ms as number,
  };
}

function normalizeRetrieval(value: unknown): SearchRetrievalConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('retrieval must be an object');
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.display_k) || (input.display_k as number) < 1 || (input.display_k as number) > 100) {
    throw new Error('retrieval display_k is invalid');
  }
  if (!Number.isSafeInteger(input.branch_k) || (input.branch_k as number) < 1 || (input.branch_k as number) > 10_000) {
    throw new Error('retrieval branch_k is invalid');
  }
  if (!Number.isSafeInteger(input.fusion_k) || (input.fusion_k as number) < 1 || (input.fusion_k as number) > 10_000) {
    throw new Error('retrieval fusion_k is invalid');
  }
  if ((input.fusion_k as number) < (input.display_k as number)) {
    throw new Error('retrieval fusion_k must include display_k');
  }
  return {
    display_k: input.display_k as number,
    branch_k: input.branch_k as number,
    fusion_k: input.fusion_k as number,
  };
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Partial<SearchRequest> | null;
  if (
    !body ||
    typeof body.query !== 'string' ||
    !body.query.trim() ||
    typeof body.task !== 'string' ||
    !SEARCH_TASKS.has(body.task as SearchRequest['task'])
  ) {
    return NextResponse.json({ message: 'query và task là bắt buộc.' }, { status: 400 });
  }

  let embedding: SearchEmbeddingConfig | undefined;
  try {
    embedding = normalizeEmbedding(body.embedding);
  } catch {
    return NextResponse.json({ message: 'Cấu hình embedding không hợp lệ.' }, { status: 400 });
  }

  let retrieval: SearchRetrievalConfig | undefined;
  try {
    retrieval = normalizeRetrieval(body.retrieval);
  } catch {
    return NextResponse.json({ message: 'Cấu hình retrieval không hợp lệ.' }, { status: 400 });
  }

  const requestedTopK = typeof body.top_k === 'number' && Number.isFinite(body.top_k) ? body.top_k : 20;
  const requestBody: SearchRequest = {
    query: body.query.trim(),
    task: body.task as SearchRequest['task'],
    top_k: retrieval?.display_k ?? Math.min(Math.max(Math.trunc(requestedTopK), 1), 100),
    session_id: typeof body.session_id === 'string' ? body.session_id : undefined,
    ...(embedding ? { embedding } : {}),
    ...(retrieval ? { retrieval } : {}),
  };

  let upstream: Response | null;
  try {
    upstream = await requestBackend('/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend tìm kiếm.' }, { status: 502 });
  }
  if (!upstream) {
    return attachMediaSession(NextResponse.json(mockSearchResponse(requestBody)));
  }

  try {
    return attachMediaSession(await forwardJsonResponse(upstream, 'Backend tìm kiếm không thể xử lý yêu cầu.'));
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend tìm kiếm.' }, { status: 502 });
  }
}
