import { NextRequest, NextResponse } from 'next/server';

import { forwardJsonResponse, requestBackend } from '../../../../../lib/backend-proxy';
import { attachMediaSession } from '../../../../../lib/server-media-access';
import type { ExactFrameSearchRequest } from '../../../../../lib/contracts';

const TASKS = new Set<ExactFrameSearchRequest['task']>(['textual_kis', 'video_kis', 'avs', 'vqa', 'trake', 'kisc']);
const SAFE_VIDEO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function normalizeRequest(value: unknown): ExactFrameSearchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body không hợp lệ');
  const body = value as Record<string, unknown>;
  if (typeof body.task !== 'string' || !TASKS.has(body.task as ExactFrameSearchRequest['task'])) {
    throw new Error('task không hợp lệ');
  }
  if (!Array.isArray(body.frames) || body.frames.length < 1 || body.frames.length > 100) {
    throw new Error('frames không hợp lệ');
  }
  const frames = body.frames.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('frame không hợp lệ');
    const frame = value as Record<string, unknown>;
    if (typeof frame.video_id !== 'string' || !SAFE_VIDEO_ID.test(frame.video_id.trim())) {
      throw new Error('video_id không hợp lệ');
    }
    if (!Number.isSafeInteger(frame.original_frame_id)
      || (frame.original_frame_id as number) < 0 || (frame.original_frame_id as number) > 2_147_483_647) {
      throw new Error('original_frame_id không hợp lệ');
    }
    return { video_id: frame.video_id.trim(), original_frame_id: frame.original_frame_id as number };
  });
  if (body.session_id !== undefined && (typeof body.session_id !== 'string' || body.session_id.length > 200)) {
    throw new Error('session_id không hợp lệ');
  }
  return {
    task: body.task as ExactFrameSearchRequest['task'],
    frames,
    ...(body.session_id === undefined ? {} : { session_id: body.session_id }),
  };
}

export async function POST(request: NextRequest) {
  let body: ExactFrameSearchRequest;
  try {
    body = normalizeRequest(await request.json());
  } catch {
    return NextResponse.json({ message: 'Yêu cầu exact-frame không hợp lệ.' }, { status: 400 });
  }

  let upstream: Response | null;
  try {
    upstream = await requestBackend('/v1/search/exact-frames', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend exact-frame.' }, { status: 502 });
  }
  if (!upstream) return NextResponse.json({ message: 'Backend exact-frame chưa được cấu hình.' }, { status: 503 });

  try {
    return attachMediaSession(await forwardJsonResponse(upstream, 'Backend exact-frame không thể xử lý yêu cầu.'));
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend exact-frame.' }, { status: 502 });
  }
}
