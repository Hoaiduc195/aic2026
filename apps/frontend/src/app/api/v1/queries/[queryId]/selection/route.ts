import { NextRequest, NextResponse } from 'next/server';

import {
  backendPathId,
  forwardJsonResponse,
  isQualificationTask,
  parseJsonObject,
  requestBackend,
} from '../../../../../../lib/backend-proxy';

interface RouteContext {
  params: Promise<{ queryId: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { queryId } = await context.params;
  if (!backendPathId(queryId)) return NextResponse.json({ message: 'query_id không hợp lệ.' }, { status: 400 });

  let upstream: Response | null;
  try {
    upstream = await requestBackend(`/v1/queries/${encodeURIComponent(queryId)}/selection`);
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend manual.' }, { status: 502 });
  }
  if (!upstream) return NextResponse.json({ message: 'Backend chưa được cấu hình.' }, { status: 503 });
  try {
    return await forwardJsonResponse(upstream, 'Backend không thể tải selection.');
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend manual.' }, { status: 502 });
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { queryId } = await context.params;
  if (!backendPathId(queryId)) return NextResponse.json({ message: 'query_id không hợp lệ.' }, { status: 400 });

  const body = await parseJsonObject(request);
  if (!body || !isQualificationTask(body.task) || !Array.isArray(body.answers) || body.answers.length < 1 || body.answers.length > 100) {
    return NextResponse.json({ message: 'task và answers không hợp lệ.' }, { status: 400 });
  }

  let upstream: Response | null;
  try {
    upstream = await requestBackend(`/v1/queries/${encodeURIComponent(queryId)}/selection`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend manual.' }, { status: 502 });
  }
  if (!upstream) return NextResponse.json({ message: 'Backend chưa được cấu hình.' }, { status: 503 });
  try {
    return await forwardJsonResponse(upstream, 'Backend không thể lưu selection.');
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend manual.' }, { status: 502 });
  }
}
