import { NextRequest, NextResponse } from 'next/server';

import { forwardJsonResponse, requestBackend } from '../../../../lib/backend-proxy';
import { mockSearchResponse } from '../../../../lib/mock-data';
import {
  SEARCH_RRF_BRANCHES,
  type SearchEmbeddingConfig,
  type SearchRequest,
  type SearchRetrievalConfig,
  type SearchRrfBranch,
  type VlmRerankConfig,
} from '../../../../lib/contracts';
import { MAX_NEAR_FRAME_WINDOW_MS } from '../../../../lib/retrieval-settings';
import { attachMediaSession } from '../../../../lib/server-media-access';

const SEARCH_TASKS = new Set<SearchRequest['task']>(['textual_kis', 'video_kis', 'avs', 'vqa', 'trake', 'kisc']);
const SAFE_VIDEO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function normalizeFrameQuery(value: unknown): SearchRequest['frame_query'] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('frame_query is invalid');
  const input = value as Record<string, unknown>;
  if (typeof input.video_id !== 'string' || !SAFE_VIDEO_ID.test(input.video_id.trim())) {
    throw new Error('frame_query is invalid');
  }
  if (!Number.isSafeInteger(input.original_frame_id)
    || (input.original_frame_id as number) < 0 || (input.original_frame_id as number) > 2_147_483_647) {
    throw new Error('frame_query is invalid');
  }
  return { video_id: input.video_id.trim(), original_frame_id: input.original_frame_id as number };
}

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

  let nearFrameWindowMs: number | undefined;
  if (input.near_frame_window_ms !== undefined) {
    if (!Number.isSafeInteger(input.near_frame_window_ms)
      || (input.near_frame_window_ms as number) < 0 || (input.near_frame_window_ms as number) > MAX_NEAR_FRAME_WINDOW_MS) {
      throw new Error('retrieval near_frame_window_ms is invalid');
    }
    nearFrameWindowMs = input.near_frame_window_ms as number;
  }

  let rrfK: number | undefined;
  if (input.rrf_k !== undefined) {
    if (!Number.isSafeInteger(input.rrf_k) || (input.rrf_k as number) < 1 || (input.rrf_k as number) > 1000) {
      throw new Error('retrieval rrf_k is invalid');
    }
    rrfK = input.rrf_k as number;
  }

  let channelWeights: SearchRetrievalConfig['channel_weights'];
  if (input.channel_weights !== undefined) {
    if (!input.channel_weights || typeof input.channel_weights !== 'object' || Array.isArray(input.channel_weights)) {
      throw new Error('retrieval channel_weights is invalid');
    }
    channelWeights = {};
    for (const [key, rawWeight] of Object.entries(input.channel_weights)) {
      if (!SEARCH_RRF_BRANCHES.includes(key as SearchRrfBranch)
        || typeof rawWeight !== 'number'
        || !Number.isFinite(rawWeight)
        || rawWeight < 0
        || rawWeight > 5) {
        throw new Error('retrieval channel_weights is invalid');
      }
      channelWeights[key as SearchRrfBranch] = rawWeight;
    }
  }

  let vlmRerank: VlmRerankConfig | undefined;
  if (input.vlm_rerank !== undefined) {
    if (!input.vlm_rerank || typeof input.vlm_rerank !== 'object' || Array.isArray(input.vlm_rerank)) {
      throw new Error('retrieval vlm_rerank is invalid');
    }
    const raw = input.vlm_rerank as Record<string, unknown>;
    if (typeof raw.enabled !== 'boolean'
      || !Number.isSafeInteger(raw.top_k) || (raw.top_k as number) < 1 || (raw.top_k as number) > 100
      || typeof raw.weight !== 'number' || !Number.isFinite(raw.weight) || raw.weight < 0 || raw.weight > 1) {
      throw new Error('retrieval vlm_rerank is invalid');
    }
    vlmRerank = { enabled: raw.enabled, top_k: raw.top_k as number, weight: raw.weight };
  }

  return {
    display_k: input.display_k as number,
    branch_k: input.branch_k as number,
    fusion_k: input.fusion_k as number,
    ...(nearFrameWindowMs === undefined ? {} : { near_frame_window_ms: nearFrameWindowMs }),
    ...(rrfK === undefined ? {} : { rrf_k: rrfK }),
    ...(channelWeights === undefined ? {} : { channel_weights: channelWeights }),
    ...(vlmRerank === undefined ? {} : { vlm_rerank: vlmRerank }),
  };
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Partial<SearchRequest> | null;
  let frameQuery: SearchRequest['frame_query'] | undefined;
  try {
    frameQuery = normalizeFrameQuery(body?.frame_query);
  } catch {
    return NextResponse.json({ message: 'Frame query không hợp lệ.' }, { status: 400 });
  }
  if (
    !body ||
    typeof body.query !== 'string' ||
    (!body.query.trim() && !frameQuery) ||
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
    ...(frameQuery ? { frame_query: frameQuery } : {}),
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
