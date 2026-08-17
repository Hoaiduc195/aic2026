import { BadRequestException } from '@nestjs/common';

import type { EmbeddingRequestConfig } from '../common/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 2000) {
    throw new BadRequestException('embedding.base_url must contain 1-2000 characters');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new BadRequestException('embedding.base_url must be a valid http or https URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BadRequestException('embedding.base_url must be http or https without credentials or query parameters');
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function parseEmbeddingOverride(value: unknown): EmbeddingRequestConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new BadRequestException('embedding must be an object');

  const apiKey = value.api_key === undefined ? undefined : value.api_key;
  if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 1000)) {
    throw new BadRequestException('embedding.api_key must be a string of at most 1000 characters');
  }
  const timeout = value.timeout_ms;
  if (!Number.isSafeInteger(timeout) || (timeout as number) < 100 || (timeout as number) > 120_000) {
    throw new BadRequestException('embedding.timeout_ms must be an integer between 100 and 120000');
  }

  return {
    base_url: requiredUrl(value.base_url),
    ...(typeof apiKey === 'string' && apiKey.trim() ? { api_key: apiKey.trim() } : {}),
    timeout_ms: timeout as number,
  };
}
