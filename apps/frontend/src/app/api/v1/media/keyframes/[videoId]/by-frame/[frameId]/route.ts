import { readFile } from 'node:fs/promises';

import { NextRequest, NextResponse } from 'next/server';

import { getKeyframePath } from '../../../../../../../../lib/server-media';
import { protectMediaRequest } from '../../../../../../../../lib/server-media-access';

interface RouteContext {
  params: Promise<{ videoId: string; frameId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const accessError = protectMediaRequest(request);
  if (accessError) return accessError;
  const { videoId, frameId: rawFrameId } = await context.params;
  const frameId = Number(rawFrameId);
  if (!Number.isSafeInteger(frameId) || frameId < 0) {
    return NextResponse.json({ message: 'frame_id không hợp lệ.' }, { status: 400 });
  }

  try {
    const image = await readFile(await getKeyframePath(videoId, frameId));
    return new Response(image, {
      headers: {
        'cache-control': 'public, max-age=3600, immutable',
        'content-type': 'image/jpeg',
      },
    });
  } catch {
    return NextResponse.json({ message: 'Không tìm thấy keyframe.' }, { status: 404 });
  }
}
