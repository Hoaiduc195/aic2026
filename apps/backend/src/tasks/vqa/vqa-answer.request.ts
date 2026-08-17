import { BadRequestException } from '@nestjs/common';

export interface VqaAnswerRequest {
  readonly query_id: string;
  readonly question: string;
  readonly video_id: string;
  readonly original_frame_id: number;
  readonly llm?: VqaClientLlmConfig;
}

export interface VqaClientLlmConfig {
  readonly base_url: string;
  readonly api_key?: string;
  readonly model: string;
  readonly timeout_ms: number;
  readonly max_tokens: number;
  readonly temperature: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new BadRequestException(`${field} has an invalid format`);
  }
  return value;
}

function question(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('question must be a string');
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 2000) {
    throw new BadRequestException('question must contain 1 to 2000 characters');
  }
  return normalized;
}

function frameId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_147_483_647) {
    throw new BadRequestException('original_frame_id must be a non-negative integer');
  }
  return value as number;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new BadRequestException(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function llmUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 2000) {
    throw new BadRequestException('llm.base_url must be a valid HTTP(S) URL');
  }
  const normalized = value.trim();
  try {
    const parsed = new URL(normalized);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('unsafe URL');
    }
  } catch {
    throw new BadRequestException('llm.base_url must be a valid HTTP(S) URL');
  }
  return normalized.replace(/\/+$/, '');
}

function llm(value: unknown): VqaClientLlmConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('llm must be an object');
  }
  const body = value as Record<string, unknown>;
  const baseUrl = llmUrl(body.base_url);
  if (typeof body.model !== 'string' || !body.model.trim() || body.model.trim().length > 200) {
    throw new BadRequestException('llm.model must be 1 to 200 characters');
  }
  if (body.api_key !== undefined && (typeof body.api_key !== 'string' || body.api_key.trim().length > 1000)) {
    throw new BadRequestException('llm.api_key must be at most 1000 characters');
  }
  if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) {
    throw new BadRequestException('llm.temperature must be a number between 0 and 2');
  }
  return {
    base_url: baseUrl,
    ...(typeof body.api_key === 'string' && body.api_key.trim() ? { api_key: body.api_key.trim() } : {}),
    model: body.model.trim(),
    timeout_ms: boundedInteger(body.timeout_ms, 'llm.timeout_ms', 100, 120_000),
    max_tokens: boundedInteger(body.max_tokens, 'llm.max_tokens', 1, 4_096),
    temperature: body.temperature,
  };
}

export function parseVqaAnswerRequest(value: unknown): VqaAnswerRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('VQA answer request must be an object');
  }
  const body = value as Record<string, unknown>;
  return {
    query_id: identifier(body.query_id, 'query_id'),
    question: question(body.question),
    video_id: identifier(body.video_id, 'video_id'),
    original_frame_id: frameId(body.original_frame_id),
    ...(body.llm === undefined ? {} : { llm: llm(body.llm) }),
  };
}
