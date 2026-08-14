import { NextRequest, NextResponse } from 'next/server';

import { forwardJsonResponse, requestBackend } from '../../../../lib/backend-proxy';
import { mockSearchResponse } from '../../../../lib/mock-data';
import type { SearchRequest } from '../../../../lib/contracts';
import { attachMediaSession } from '../../../../lib/server-media-access';

const SEARCH_TASKS = new Set<SearchRequest['task']>(['textual_kis', 'video_kis', 'avs', 'vqa', 'trake', 'kisc']);

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

  const requestedTopK = typeof body.top_k === 'number' && Number.isFinite(body.top_k) ? body.top_k : 20;
  const requestBody: SearchRequest = {
    query: body.query.trim(),
    task: body.task as SearchRequest['task'],
    top_k: Math.min(Math.max(Math.trunc(requestedTopK), 1), 100),
    session_id: typeof body.session_id === 'string' ? body.session_id : undefined,
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
