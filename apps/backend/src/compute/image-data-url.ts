const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 5_000;
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export interface FetchImageAsDataUrlOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

function supportedImageType(value: string | null): string | undefined {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  return normalized && SUPPORTED_IMAGE_TYPES.has(normalized) ? normalized : undefined;
}

function sniffImageType(bytes: Buffer): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

async function readBodyWithinLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`image response exceeds maximum size of ${maxBytes} bytes`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`image response exceeds maximum size of ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function fetchImageAsDataUrl(
  imageUrl: string,
  options: FetchImageAsDataUrlOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_FETCH_TIMEOUT_MS;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('image maxBytes must be a positive integer');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('image timeoutMs must be a positive integer');

  const normalizedUrl = imageUrl.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    throw new Error('image URL must be absolute');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('image URL must use HTTP(S)');
  }

  const response = await fetch(normalizedUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`image fetch returned HTTP ${response.status}`);
  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`image response exceeds maximum size of ${maxBytes} bytes`);
  }

  const bytes = await readBodyWithinLimit(response, maxBytes);
  if (bytes.byteLength === 0) throw new Error('image response is empty');

  const declaredType = supportedImageType(response.headers.get('content-type'));
  const rawContentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const contentType = declaredType
    ?? ((rawContentType === undefined || rawContentType === ''
      || rawContentType === 'application/octet-stream' || rawContentType === 'binary/octet-stream')
      ? sniffImageType(bytes)
      : undefined);
  if (!contentType) throw new Error('image response is not a supported image');

  return `data:${contentType};base64,${bytes.toString('base64')}`;
}
