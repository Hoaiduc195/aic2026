import { NextRequest, NextResponse } from 'next/server';

import {
  backendPathId,
  forwardJsonResponse,
  isRecord,
  parseJsonObject,
  requestBackend,
} from '../../../../../lib/backend-proxy';

function validQuestion(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 2000;
}

function validFrameId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

function normalizeModelConfig(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (typeof value.base_url !== 'string' || value.base_url.trim().length < 1 || value.base_url.trim().length > 2000) return null;
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.trim().length > 200) return null;
  if (value.api_key !== undefined && (typeof value.api_key !== 'string' || value.api_key.length > 1000)) return null;
  if (typeof value.timeout_ms !== 'number' || !Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < 100 || value.timeout_ms > 120_000) return null;
  if (typeof value.max_tokens !== 'number' || !Number.isSafeInteger(value.max_tokens) || value.max_tokens < 1 || value.max_tokens > 4_096) return null;
  if (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2) return null;
  try {
    const endpoint = new URL(value.base_url.trim());
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
  } catch {
    return null;
  }
  return {
    base_url: value.base_url.trim().replace(/\/+$/, ''),
    ...(typeof value.api_key === 'string' && value.api_key.trim() ? { api_key: value.api_key.trim() } : {}),
    model: value.model.trim(),
    timeout_ms: value.timeout_ms,
    max_tokens: value.max_tokens,
    temperature: value.temperature,
  };
}

export async function POST(request: NextRequest) {
  const body = await parseJsonObject(request);
  if (
    !body
    || typeof body.query_id !== 'string'
    || !backendPathId(body.query_id)
    || !validQuestion(body.question)
    || typeof body.video_id !== 'string'
    || !backendPathId(body.video_id)
    || !validFrameId(body.original_frame_id)
    || (body.llm !== undefined && !normalizeModelConfig(body.llm))
    || (body.vlm !== undefined && !normalizeModelConfig(body.vlm))
  ) {
    return NextResponse.json({ message: 'query_id, question, video_id và original_frame_id là bắt buộc.' }, { status: 400 });
  }

  let upstream: Response | null;
  try {
    upstream = await requestBackend('/v1/vqa/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query_id: body.query_id,
        question: body.question.trim(),
        video_id: body.video_id,
        original_frame_id: body.original_frame_id,
        ...(body.llm === undefined ? {} : { llm: normalizeModelConfig(body.llm) }),
        ...(body.vlm === undefined ? {} : { vlm: normalizeModelConfig(body.vlm) }),
      }),
    });
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend trả lời VQA.' }, { status: 502 });
  }
  if (!upstream) return NextResponse.json({ message: 'Backend VQA chưa được cấu hình.' }, { status: 503 });

  try {
    return await forwardJsonResponse(upstream, 'Backend VQA không thể sinh câu trả lời.');
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend trả lời VQA.' }, { status: 502 });
  }
}
