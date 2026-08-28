import { NextRequest, NextResponse } from 'next/server';

import { forwardJsonResponse, requestBackend } from '../../../../../lib/backend-proxy';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ message: 'Agent request phải là object.' }, { status: 400 });
  }

  let upstream: Response | null;
  try {
    upstream = await requestBackend('/v1/agent/frame-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!upstream) return NextResponse.json({ message: 'Backend chưa được cấu hình.' }, { status: 503 });
    return await forwardJsonResponse(await upstream, 'Backend agent không thể tạo run.');
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend agent.' }, { status: 502 });
  }
}
