import { NextRequest, NextResponse } from 'next/server';

import {
  forwardJsonResponse,
  isQualificationTask,
  parseJsonObject,
  requestBackend,
} from '../../../../../lib/backend-proxy';

export async function POST(request: NextRequest) {
  const body = await parseJsonObject(request);
  if (!body || typeof body.query_id !== 'string' || !body.query_id.trim() || !isQualificationTask(body.task)
    || !Array.isArray(body.answers) || body.answers.length < 1 || body.answers.length > 100) {
    return NextResponse.json({ message: 'query_id, task và answers không hợp lệ.' }, { status: 400 });
  }

  let upstream: Response | null;
  try {
    upstream = await requestBackend('/v1/submissions/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend submission.' }, { status: 502 });
  }
  if (!upstream) return NextResponse.json({ message: 'Backend chưa được cấu hình.' }, { status: 503 });
  try {
    return await forwardJsonResponse(upstream, 'Backend không thể tạo submission preview.');
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend submission.' }, { status: 502 });
  }
}
