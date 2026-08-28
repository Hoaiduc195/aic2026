import { NextRequest, NextResponse } from 'next/server';

import { backendPathId, forwardJsonResponse, requestBackend } from '../../../../../../lib/backend-proxy';
import { MAX_NEARBY_FRAME_COUNT, MAX_NEARBY_FRAME_STEP } from '../../../../../../lib/nearby-frame-model';
import { getFrameContext } from '../../../../../../lib/server-media';
import { protectMediaRequest } from '../../../../../../lib/server-media-access';

interface RouteContext {
  params: Promise<{ videoId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const accessError = protectMediaRequest(request);
  if (accessError) return accessError;
  const { videoId } = await context.params;
  const centerFrameId = Number(request.nextUrl.searchParams.get('center_frame_id'));
  const requestedLimit = Number(request.nextUrl.searchParams.get('limit') ?? 25);
  const rawFrameStep = request.nextUrl.searchParams.get('frame_step');
  const requestedFrameStep = Number(rawFrameStep ?? 1);
  if (!Number.isSafeInteger(centerFrameId) || centerFrameId < 0
    || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_NEARBY_FRAME_COUNT
    || !Number.isSafeInteger(requestedFrameStep) || requestedFrameStep < 1 || requestedFrameStep > MAX_NEARBY_FRAME_STEP) {
    return NextResponse.json({ message: 'center_frame_id, limit hoặc frame_step không hợp lệ.' }, { status: 400 });
  }
  if (!backendPathId(videoId)) {
    return NextResponse.json({ message: 'video_id không hợp lệ.' }, { status: 400 });
  }

  let upstream: Response | null;
  try {
    upstream = await requestBackend(
      `/v1/videos/${encodeURIComponent(videoId)}/frames?center_frame_id=${centerFrameId}&limit=${requestedLimit}${rawFrameStep === null ? '' : `&frame_step=${requestedFrameStep}`}`,
    );
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend media.' }, { status: 502 });
  }
  if (upstream) {
    try {
      return await forwardJsonResponse(upstream, 'Backend không thể tải frame context.');
    } catch {
      return NextResponse.json({ message: 'Không thể kết nối tới backend media.' }, { status: 502 });
    }
  }

  try {
    return NextResponse.json(await getFrameContext(videoId, centerFrameId, requestedLimit, requestedFrameStep));
  } catch {
    return NextResponse.json({ message: 'Không tìm thấy mapping frame cho video.' }, { status: 404 });
  }
}
