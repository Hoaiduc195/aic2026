import { NextRequest, NextResponse } from 'next/server';

import { backendPathId, forwardJsonResponse, requestBackend } from '../../../../../../lib/backend-proxy';
import { getPlayback } from '../../../../../../lib/server-media';
import { protectMediaRequest } from '../../../../../../lib/server-media-access';

interface RouteContext {
  params: Promise<{ videoId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const accessError = protectMediaRequest(request);
  if (accessError) return accessError;
  const { videoId } = await context.params;
  const frameId = Number(request.nextUrl.searchParams.get('frame_id'));
  if (!Number.isSafeInteger(frameId) || frameId < 0) {
    return NextResponse.json({ message: 'frame_id không hợp lệ.' }, { status: 400 });
  }
  if (!backendPathId(videoId)) {
    return NextResponse.json({ message: 'video_id không hợp lệ.' }, { status: 400 });
  }

  let upstream: Response | null;
  try {
    upstream = await requestBackend(
      `/v1/videos/${encodeURIComponent(videoId)}/playback?frame_id=${frameId}`,
    );
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend media.' }, { status: 502 });
  }
  if (upstream) {
    try {
      return await forwardJsonResponse(upstream, 'Backend không thể tải video.');
    } catch {
      return NextResponse.json({ message: 'Không thể kết nối tới backend media.' }, { status: 502 });
    }
  }

  try {
    return NextResponse.json(await getPlayback(videoId));
  } catch {
    return NextResponse.json({ message: 'Không tìm thấy video hoặc metadata tương ứng.' }, { status: 404 });
  }
}
