import { NextRequest, NextResponse } from 'next/server';

import { backendPathId, forwardJsonResponse, requestBackend } from '../../../../../../lib/backend-proxy';

interface RouteContext {
  params: Promise<{ queryId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { queryId } = await context.params;
  if (!backendPathId(queryId)) return NextResponse.json({ message: 'query_id không hợp lệ.' }, { status: 400 });

  const limit = Number(request.nextUrl.searchParams.get('limit') ?? 100);
  const offset = Number(request.nextUrl.searchParams.get('offset') ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) {
    return NextResponse.json({ message: 'limit hoặc offset không hợp lệ.' }, { status: 400 });
  }

  let upstream: Response | null;
  try {
    upstream = await requestBackend(
      `/v1/queries/${encodeURIComponent(queryId)}/candidates?limit=${limit}&offset=${offset}`,
    );
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend manual.' }, { status: 502 });
  }
  if (!upstream) return NextResponse.json({ message: 'Backend chưa được cấu hình.' }, { status: 503 });
  try {
    return await forwardJsonResponse(upstream, 'Backend không thể tải candidates.');
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend manual.' }, { status: 502 });
  }
}
