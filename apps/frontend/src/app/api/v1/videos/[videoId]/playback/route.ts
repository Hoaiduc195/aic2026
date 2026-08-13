import { NextRequest, NextResponse } from 'next/server';

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

  try {
    return NextResponse.json(await getPlayback(videoId));
  } catch {
    return NextResponse.json({ message: 'Không tìm thấy video hoặc metadata tương ứng.' }, { status: 404 });
  }
}
