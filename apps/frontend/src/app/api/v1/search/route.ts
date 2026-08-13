import { NextRequest, NextResponse } from 'next/server';

import { mockSearchResponse } from '../../../../lib/mock-data';
import type { SearchRequest } from '../../../../lib/contracts';
import { attachMediaSession, validateMediaOperatorRequest } from '../../../../lib/server-media-access';

const SEARCH_TASKS = new Set<SearchRequest['task']>(['textual_kis', 'video_kis', 'avs', 'vqa', 'trake', 'kisc']);

export async function POST(request: NextRequest) {
  const mediaAccessError = validateMediaOperatorRequest(request);
  if (mediaAccessError) return mediaAccessError;
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

  const requestedTopK = typeof body.top_k === 'number' && Number.isFinite(body.top_k) ? body.top_k : 20;
  const requestBody: SearchRequest = {
    query: body.query.trim(),
    task: body.task as SearchRequest['task'],
    top_k: Math.min(Math.max(Math.trunc(requestedTopK), 1), 100),
    session_id: typeof body.session_id === 'string' ? body.session_id : undefined,
  };

  const backendUrl = process.env.BACKEND_API_URL?.replace(/\/$/, '');
  if (!backendUrl) {
    return attachMediaSession(NextResponse.json(mockSearchResponse(requestBody)));
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const operatorToken = request.headers.get('x-operator-token');
  if (operatorToken) headers['x-operator-token'] = operatorToken;

  try {
    const upstream = await fetch(`${backendUrl}/v1/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      cache: 'no-store',
    });
    const payload = await upstream.json().catch(() => ({ message: 'Backend trả về dữ liệu không hợp lệ.' }));
    if (!upstream.ok) {
      return NextResponse.json({ message: publicUpstreamError(upstream.status) }, { status: upstream.status });
    }
    return attachMediaSession(NextResponse.json(payload));
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend tìm kiếm.' }, { status: 502 });
  }
}

function publicUpstreamError(status: number): string {
  if (status === 400 || status === 422) return 'Yêu cầu tìm kiếm không hợp lệ.';
  if (status === 401 || status === 403) return 'Không có quyền thực hiện tìm kiếm.';
  if (status === 429) return 'Hệ thống đang nhận quá nhiều yêu cầu. Vui lòng thử lại sau.';
  return 'Backend tìm kiếm không thể xử lý yêu cầu.';
}
