import { NextRequest, NextResponse } from 'next/server';

import { forwardJsonResponse, isRecord, parseJsonObject, requestBackend } from '../../../../../lib/backend-proxy';

const TASKS = new Set(['textual_kis', 'vqa', 'trake']);

function normalizeEvents(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return null;
  if (value.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > 2000)) return null;
  return value.map((item) => (item as string).trim());
}

function normalizeModelConfig(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (typeof value.base_url !== 'string' || !value.base_url.trim() || value.base_url.trim().length > 2000) return null;
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.trim().length > 200) return null;
  if (value.api_key !== undefined && (typeof value.api_key !== 'string' || value.api_key.length > 1000)) return null;
  if (!Number.isSafeInteger(value.timeout_ms) || (value.timeout_ms as number) < 100 || (value.timeout_ms as number) > 120_000) return null;
  if (!Number.isSafeInteger(value.max_tokens) || (value.max_tokens as number) < 1 || (value.max_tokens as number) > 4_096) return null;
  if (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2) return null;
  try {
    const endpoint = new URL(value.base_url.trim());
    if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
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
  const events = body?.events === undefined ? undefined : normalizeEvents(body.events);
  if (!body || typeof body.query !== 'string' || !body.query.trim() || body.query.trim().length > 2000
    || typeof body.task !== 'string' || !TASKS.has(body.task)
    || (body.question !== undefined && (typeof body.question !== 'string'
      || !body.question.trim() || body.question.trim().length > 2000))
    || (body.task === 'vqa' && (typeof body.question !== 'string' || !body.question.trim()))
    || (body.events !== undefined && (body.task !== 'trake' || events === null))
    || (body.llm !== undefined && !normalizeModelConfig(body.llm))) {
    return NextResponse.json({ message: 'query, task hoặc cấu hình LLM không hợp lệ.' }, { status: 400 });
  }

  let upstream: Response | null;
  try {
    upstream = await requestBackend('/v1/query/improve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: body.query.trim(),
        ...(typeof body.question === 'string' ? { question: body.question.trim() } : {}),
        ...(events === undefined ? {} : { events }),
        task: body.task,
        ...(body.llm === undefined ? {} : { llm: normalizeModelConfig(body.llm) }),
      }),
    });
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend query improver.' }, { status: 502 });
  }
  if (!upstream) return NextResponse.json({ message: 'Backend query improver chưa được cấu hình.' }, { status: 503 });

  try {
    return await forwardJsonResponse(upstream, 'Backend query improver không thể xử lý yêu cầu.');
  } catch {
    return NextResponse.json({ message: 'Không thể kết nối tới backend query improver.' }, { status: 502 });
  }
}
