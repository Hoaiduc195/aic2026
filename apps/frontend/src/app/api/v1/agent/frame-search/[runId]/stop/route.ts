import { NextRequest, NextResponse } from 'next/server';

import { backendPathId, forwardJsonResponse, requestBackend } from '../../../../../../../lib/backend-proxy';

interface RouteContext {
  params: Promise<{ runId: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const { runId } = await context.params;
  if (!backendPathId(runId)) return NextResponse.json({ message: 'run_id không hợp lệ.' }, { status: 400 });
  try {
    const upstream = requestBackend(`/v1/agent/frame-search/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
    if (!upstream) return NextResponse.json({ message: 'Backend chưa được cấu hình.' }, { status: 503 });
    return await forwardJsonResponse(await upstream, 'Không thể dừng agent run.');
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend agent.' }, { status: 502 });
  }
}
