import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_SCOPE = 'aic-media-session-v1';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function createMediaSessionToken(
  secret: string,
  expiresAt = Date.now() + SESSION_TTL_MS,
  nonce = randomBytes(18).toString('base64url'),
): string {
  if (!secret.trim()) throw new Error('media access secret không hợp lệ');
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !/^[A-Za-z0-9_-]{8,}$/.test(nonce)) {
    throw new Error('media session payload không hợp lệ');
  }
  const payload = `${nonce}.${expiresAt}`;
  const signature = createHmac('sha256', secret).update(`${SESSION_SCOPE}.${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyMediaSessionToken(secret: string, token: string | null, now = Date.now()): boolean {
  if (!token) return false;
  const [nonce, rawExpiresAt, signature, extra] = token.split('.');
  const expiresAt = Number(rawExpiresAt);
  if (extra || !nonce || !signature || !Number.isSafeInteger(expiresAt) || expiresAt < now) return false;
  try {
    return safeTokenEqual(createMediaSessionToken(secret, expiresAt, nonce), token);
  } catch {
    return false;
  }
}

export function safeTokenEqual(expected: string, supplied: string | null): boolean {
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
