import { NextRequest, NextResponse } from 'next/server';

import { backendPathId, isRecord, publicBackendError, readJsonResponse, requestBackend } from '../../../../../../../../lib/backend-proxy';
import { protectMediaRequest } from '../../../../../../../../lib/server-media-access';

interface RouteContext {
  params: Promise<{ videoId: string; frameId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const accessError = protectMediaRequest(request);
  if (accessError) return accessError;
  const { videoId, frameId: rawFrameId } = await context.params;
  const frameId = Number(rawFrameId);
  if (!backendPathId(videoId)) return NextResponse.json({ message: 'video_id không hợp lệ.' }, { status: 400 });
  if (!Number.isSafeInteger(frameId) || frameId < 0) {
    return NextResponse.json({ message: 'frame_id không hợp lệ.' }, { status: 400 });
  }

  let upstream: Response | null;
  try {
    upstream = await requestBackend(`/v1/videos/${encodeURIComponent(videoId)}/frames/${frameId}`);
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend media.' }, { status: 502 });
  }
  if (!upstream) return NextResponse.json({ message: 'Backend media chưa được cấu hình.' }, { status: 503 });
  if (!upstream.ok) {
    return NextResponse.json(
      { message: publicBackendError(upstream.status, 'Backend không thể tải canonical frame.') },
      { status: upstream.status },
    );
  }
  const payload = await readJsonResponse(upstream);
  if (!isRecord(payload)) return NextResponse.json({ message: 'Backend trả về dữ liệu frame không hợp lệ.' }, { status: 502 });
  return NextResponse.json({
    ...payload,
    thumbnail_uri: `/api/v1/media/videos/${encodeURIComponent(videoId)}/frames/${frameId}/thumbnail`,
  });
}
