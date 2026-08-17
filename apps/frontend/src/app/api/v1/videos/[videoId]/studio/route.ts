import { NextRequest, NextResponse } from 'next/server';

import { backendPathId, forwardJsonResponse, requestBackend } from '../../../../../../lib/backend-proxy';
import { protectMediaRequest } from '../../../../../../lib/server-media-access';

interface RouteContext {
  params: Promise<{ videoId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const accessError = protectMediaRequest(request);
  if (accessError) return accessError;

  const { videoId } = await context.params;
  if (!backendPathId(videoId)) {
    return NextResponse.json({ message: 'video_id không hợp lệ.' }, { status: 400 });
  }

  let upstream: Response | null;
  try {
    upstream = await requestBackend(`/v1/videos/${encodeURIComponent(videoId)}/studio`);
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend studio.' }, { status: 502 });
  }
  if (!upstream) {
    return NextResponse.json({ message: 'Backend studio chưa được cấu hình.' }, { status: 503 });
  }

  try {
    return await forwardJsonResponse(await upstream, 'Backend không thể tải dữ liệu studio.');
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend studio.' }, { status: 502 });
  }
}
