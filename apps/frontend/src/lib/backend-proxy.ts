import 'server-only';

import { NextResponse } from 'next/server';

export function backendBaseUrl(): string | null {
  const value = process.env.BACKEND_API_URL?.trim().replace(/\/$/, '');
  return value || null;
}

export function backendPathId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
}

export function requestBackend(path: string, init: RequestInit = {}): Promise<Response> | null {
  const baseUrl = backendBaseUrl();
  if (!baseUrl) return null;

  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const operatorToken = process.env.BACKEND_OPERATOR_TOKEN?.trim();
  if (operatorToken) headers.set('x-operator-token', operatorToken);

  return fetch(`${baseUrl}${path}`, {
    ...init,
    cache: 'no-store',
    headers,
  });
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function forwardJsonResponse(response: Response, fallback: string): Promise<NextResponse> {
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    return NextResponse.json({ message: publicBackendError(response.status, fallback) }, { status: response.status });
  }
  if (payload === null) {
    return NextResponse.json({ message: 'Backend trả về dữ liệu không hợp lệ.' }, { status: 502 });
  }
  return NextResponse.json(payload, { status: response.status });
}

export function publicBackendError(status: number, fallback: string): string {
  if (status === 400 || status === 422) return 'Yêu cầu không hợp lệ.';
  if (status === 401 || status === 403) return 'Không có quyền thực hiện yêu cầu.';
  if (status === 404) return 'Không tìm thấy dữ liệu yêu cầu.';
  if (status === 429) return 'Hệ thống đang nhận quá nhiều yêu cầu. Vui lòng thử lại sau.';
  return fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isQualificationTask(value: unknown): value is 'textual_kis' | 'vqa' | 'trake' {
  return value === 'textual_kis' || value === 'vqa' || value === 'trake';
}

export async function parseJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const value = await request.json().catch(() => null);
  return isRecord(value) ? value : null;
}
