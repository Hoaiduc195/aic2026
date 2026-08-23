import { NextRequest, NextResponse } from 'next/server';

import { backendPathId, isRecord, publicBackendError, readJsonResponse, requestBackend } from '../../../../../../../lib/backend-proxy';
import { protectMediaRequest } from '../../../../../../../lib/server-media-access';

interface RouteContext {
  params: Promise<{ videoId: string; keyframeNo: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const accessError = protectMediaRequest(request);
  if (accessError) return accessError;
  const { videoId, keyframeNo: rawKeyframeNo } = await context.params;
  const keyframeNo = Number(rawKeyframeNo);
  if (!backendPathId(videoId)) return NextResponse.json({ message: 'video_id không hợp lệ.' }, { status: 400 });
  if (!Number.isSafeInteger(keyframeNo) || keyframeNo < 1) {
    return NextResponse.json({ message: 'keyframe_no không hợp lệ.' }, { status: 400 });
  }

  let upstream: Response | null;
  try {
    upstream = await requestBackend(`/v1/videos/${encodeURIComponent(videoId)}/keyframes/${keyframeNo}`);
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend media.' }, { status: 502 });
  }
  if (!upstream) return NextResponse.json({ message: 'Backend media chưa được cấu hình.' }, { status: 503 });
  if (!upstream.ok) {
    return NextResponse.json(
      { message: publicBackendError(upstream.status, 'Backend không thể tải keyframe.') },
      { status: upstream.status },
    );
  }
  const payload = await readJsonResponse(upstream);
  if (!isRecord(payload) || typeof payload.original_frame_id !== 'number') {
    return NextResponse.json({ message: 'Backend trả về dữ liệu keyframe không hợp lệ.' }, { status: 502 });
  }
  return NextResponse.json({
    ...payload,
    thumbnail_uri: `/api/v1/media/videos/${encodeURIComponent(videoId)}/frames/${payload.original_frame_id}/thumbnail`,
  });
}
