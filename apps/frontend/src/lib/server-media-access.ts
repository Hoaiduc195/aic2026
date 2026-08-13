import 'server-only';

import { NextRequest, NextResponse } from 'next/server';

import { createMediaSessionToken, safeTokenEqual, verifyMediaSessionToken } from './media-access';

const MEDIA_SESSION_COOKIE = 'aic_media_session';
const RATE_WINDOW_MS = 60_000;
const MAX_MEDIA_REQUESTS = 240;

interface RateWindow {
  count: number;
  resetAt: number;
}

let rateWindows = new Map<string, RateWindow>();

export function validateMediaOperatorRequest(request: NextRequest): NextResponse | null {
  const secret = configuredSecret();
  if (!secret) return allowsUnauthenticatedMedia(request)
    ? null
    : NextResponse.json({ message: 'Media access chưa được cấu hình.' }, { status: 503 });

  return safeTokenEqual(secret, request.headers.get('x-operator-token'))
    ? null
    : NextResponse.json({ message: 'Không có quyền truy cập media.' }, { status: 401 });
}

export function attachMediaSession(response: NextResponse): NextResponse {
  const secret = configuredSecret();
  if (!secret) return response;
  response.cookies.set(MEDIA_SESSION_COOKIE, createMediaSessionToken(secret), {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60,
    path: '/api/v1',
  });
  return response;
}

export function protectMediaRequest(request: NextRequest): NextResponse | null {
  const secret = configuredSecret();
  if (!secret && !allowsUnauthenticatedMedia(request)) {
    return NextResponse.json({ message: 'Media access chưa được cấu hình.' }, { status: 503 });
  }
  if (secret && !verifyMediaSessionToken(secret, request.cookies.get(MEDIA_SESSION_COOKIE)?.value ?? null)) {
    return NextResponse.json({ message: 'Không có quyền truy cập media.' }, { status: 401 });
  }
  return enforceRateLimit(request);
}

function enforceRateLimit(request: NextRequest): NextResponse | null {
  const now = Date.now();
  const session = request.cookies.get(MEDIA_SESSION_COOKIE)?.value;
  const forwardedIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const key = session || forwardedIp || 'local';
  const current = rateWindows.get(key);
  const next = !current || current.resetAt <= now
    ? { count: 1, resetAt: now + RATE_WINDOW_MS }
    : { count: current.count + 1, resetAt: current.resetAt };
  rateWindows = new Map(
    [...rateWindows.entries()].filter(([, value]) => value.resetAt > now),
  );
  rateWindows.set(key, next);
  if (next.count <= MAX_MEDIA_REQUESTS) return null;
  return NextResponse.json(
    { message: 'Quá nhiều yêu cầu media.' },
    { status: 429, headers: { 'retry-after': String(Math.ceil((next.resetAt - now) / 1000)) } },
  );
}

function configuredSecret(): string | null {
  return process.env.AIC_MEDIA_ACCESS_TOKEN?.trim() || null;
}

function allowsUnauthenticatedMedia(request: NextRequest): boolean {
  if (process.env.AIC_ALLOW_UNAUTHENTICATED_MEDIA === 'true') return true;
  if (process.env.NODE_ENV === 'production') return false;
  const hostname = request.nextUrl.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}
