import { BadRequestException } from '@nestjs/common';

import { TASK_TYPES, type TaskType } from '../common/types';

export interface QueryImproverModelConfig {
  readonly base_url: string;
  readonly api_key?: string;
  readonly model: string;
  readonly timeout_ms: number;
  readonly max_tokens: number;
  readonly temperature: number;
}

export interface QueryImprovementRequest {
  readonly query: string;
  readonly question?: string;
  readonly task: Extract<TaskType, 'textual_kis' | 'vqa' | 'trake'>;
  readonly llm?: QueryImproverModelConfig;
}

const IMPROVABLE_TASKS = new Set<QueryImprovementRequest['task']>(['textual_kis', 'vqa', 'trake']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new BadRequestException(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function modelUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 2000) {
    throw new BadRequestException('llm.base_url must be a valid HTTP(S) URL');
  }
  const normalized = value.trim();
  try {
    const parsed = new URL(normalized);
    if (!['http:', 'https:'].includes(parsed.protocol)
      || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('unsafe URL');
    }
  } catch {
    throw new BadRequestException('llm.base_url must be a valid HTTP(S) URL');
  }
  return normalized.replace(/\/+$/, '');
}

function modelConfig(value: unknown): QueryImproverModelConfig {
  if (!isRecord(value)) throw new BadRequestException('llm must be an object');
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.trim().length > 200) {
    throw new BadRequestException('llm.model must contain 1 to 200 characters');
  }
  if (value.api_key !== undefined && (typeof value.api_key !== 'string' || value.api_key.trim().length > 1000)) {
    throw new BadRequestException('llm.api_key must be at most 1000 characters');
  }
  if (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature)
    || value.temperature < 0 || value.temperature > 2) {
    throw new BadRequestException('llm.temperature must be a number between 0 and 2');
  }
  return {
    base_url: modelUrl(value.base_url),
    ...(typeof value.api_key === 'string' && value.api_key.trim() ? { api_key: value.api_key.trim() } : {}),
    model: value.model.trim(),
    timeout_ms: boundedInteger(value.timeout_ms, 'llm.timeout_ms', 100, 120_000),
    max_tokens: boundedInteger(value.max_tokens, 'llm.max_tokens', 1, 4_096),
    temperature: value.temperature,
  };
}

export function parseQueryImprovementRequest(value: unknown): QueryImprovementRequest {
  if (!isRecord(value)) throw new BadRequestException('query improvement request must be an object');
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.trim().length > 2000) {
    throw new BadRequestException('query must contain 1 to 2000 characters');
  }
  if (typeof value.task !== 'string' || !TASK_TYPES.includes(value.task as TaskType)
    || !IMPROVABLE_TASKS.has(value.task as QueryImprovementRequest['task'])) {
    throw new BadRequestException('task must be textual_kis, vqa or trake');
  }
  if (value.question !== undefined && (typeof value.question !== 'string'
    || !value.question.trim() || value.question.trim().length > 2000)) {
    throw new BadRequestException('question must contain 1 to 2000 characters');
  }
  if (value.task === 'vqa' && value.question === undefined) {
    throw new BadRequestException('question is required for vqa query improvement');
  }
  return {
    query: value.query.trim(),
    ...(typeof value.question === 'string' ? { question: value.question.trim() } : {}),
    task: value.task as QueryImprovementRequest['task'],
    ...(value.llm === undefined ? {} : { llm: modelConfig(value.llm) }),
  };
}
