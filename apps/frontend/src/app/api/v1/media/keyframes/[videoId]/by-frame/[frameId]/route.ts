import { readFile } from 'node:fs/promises';

import { NextRequest, NextResponse } from 'next/server';

import { backendPathId, isRecord, publicBackendError, readJsonResponse, requestBackend } from '../../../../../../../../lib/backend-proxy';
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
  if (!backendPathId(videoId)) {
    return NextResponse.json({ message: 'video_id không hợp lệ.' }, { status: 400 });
  }

  let upstream: Response | null;
  try {
    upstream = await requestBackend(
      `/v1/videos/${encodeURIComponent(videoId)}/frames?center_frame_id=${frameId}&limit=100`,
    );
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend media.' }, { status: 502 });
  }
  if (upstream) {
    try {
      if (!upstream.ok) {
        return NextResponse.json(
          { message: publicBackendError(upstream.status, 'Backend không thể tải keyframe.') },
          { status: upstream.status },
        );
      }
      const payload = await readJsonResponse(upstream);
      const frame = isRecord(payload) && Array.isArray(payload.frames)
        ? payload.frames.find((item) => isRecord(item) && item.original_frame_id === frameId)
        : undefined;
      const thumbnailUri = isRecord(frame) && typeof frame.thumbnail_uri === 'string'
        ? frame.thumbnail_uri
        : null;
      if (!thumbnailUri || !/^https?:\/\/[^\s]+$/i.test(thumbnailUri)) {
        return NextResponse.json({ message: 'Không tìm thấy keyframe.' }, { status: 404 });
      }
      return NextResponse.redirect(thumbnailUri);
    } catch {
      return NextResponse.json({ message: 'Không thể kết nối tới backend media.' }, { status: 502 });
    }
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
