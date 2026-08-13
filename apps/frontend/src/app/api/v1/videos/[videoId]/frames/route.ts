import { NextRequest, NextResponse } from 'next/server';

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
  if (!Number.isSafeInteger(centerFrameId) || centerFrameId < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
    return NextResponse.json({ message: 'center_frame_id hoặc limit không hợp lệ.' }, { status: 400 });
  }

  try {
    return NextResponse.json(await getFrameContext(videoId, centerFrameId, requestedLimit));
  } catch {
    return NextResponse.json({ message: 'Không tìm thấy mapping frame cho video.' }, { status: 404 });
  }
}
