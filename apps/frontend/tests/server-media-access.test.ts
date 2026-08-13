import { NextRequest, NextResponse } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  attachMediaSession,
  protectMediaRequest,
  validateMediaOperatorRequest,
} from '@/lib/server-media-access';

afterEach(() => {
  delete process.env.AIC_MEDIA_ACCESS_TOKEN;
  delete process.env.AIC_ALLOW_UNAUTHENTICATED_MEDIA;
});

describe('server media access', () => {
  it('exchanges a valid operator token for an HttpOnly media session', () => {
    process.env.AIC_MEDIA_ACCESS_TOKEN = 'test-operator-secret';
    const operatorRequest = new NextRequest('http://localhost/api/v1/search', {
      headers: { 'x-operator-token': 'test-operator-secret' },
    });
    expect(validateMediaOperatorRequest(operatorRequest)).toBeNull();

    const response = attachMediaSession(NextResponse.json({ ok: true }));
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('aic_media_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).not.toContain('test-operator-secret');

    const sessionCookie = setCookie.split(';')[0];
    const mediaRequest = new NextRequest('http://localhost/api/v1/media/videos/L21_V001', {
      headers: { cookie: sessionCookie },
    });
    expect(protectMediaRequest(mediaRequest)).toBeNull();
  });

  it('rejects wrong operator credentials and missing media sessions', () => {
    process.env.AIC_MEDIA_ACCESS_TOKEN = 'test-operator-secret';
    const wrongOperator = new NextRequest('http://localhost/api/v1/search', {
      headers: { 'x-operator-token': 'wrong-secret' },
    });
    expect(validateMediaOperatorRequest(wrongOperator)?.status).toBe(401);

    const mediaRequest = new NextRequest('http://localhost/api/v1/media/videos/L21_V001');
    expect(protectMediaRequest(mediaRequest)?.status).toBe(401);
  });

  it('keeps unauthenticated media available in local development', () => {
    const request = new NextRequest('http://localhost/api/v1/media/videos/L21_V001');
    expect(protectMediaRequest(request)).toBeNull();
  });

  it('does not treat a remote development host as local media access', () => {
    const request = new NextRequest('http://192.0.2.10/api/v1/media/videos/L21_V001');
    expect(protectMediaRequest(request)?.status).toBe(503);
  });
});
