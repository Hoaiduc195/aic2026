import { BadRequestException } from '@nestjs/common';

import { parseEmbeddingOverride } from '../embedding_services/embedding-request';
import { TASK_TYPES, type RetrievalOverrides, type SearchRequest, type TaskType } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new BadRequestException(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function optionalOverrides(value: unknown): RetrievalOverrides | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new BadRequestException('retrieval must be an object');

  const overrides: { branch_k?: number; fusion_k?: number; display_k?: number; latency_budget_ms?: number } = {};
  if (value.branch_k !== undefined) overrides.branch_k = boundedInteger(value.branch_k, 'retrieval.branch_k', 1, 10000);
  if (value.fusion_k !== undefined) overrides.fusion_k = boundedInteger(value.fusion_k, 'retrieval.fusion_k', 1, 10000);
  if (value.display_k !== undefined) overrides.display_k = boundedInteger(value.display_k, 'retrieval.display_k', 1, 1000);
  if (value.latency_budget_ms !== undefined) {
    overrides.latency_budget_ms = boundedInteger(value.latency_budget_ms, 'retrieval.latency_budget_ms', 10, 30000);
  }
  return overrides;
}

export function parseSearchRequest(value: unknown): SearchRequest {
  if (!isRecord(value)) throw new BadRequestException('request body must be an object');
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.trim().length > 2000) {
    throw new BadRequestException('query must contain 1-2000 characters');
  }
  if (typeof value.task !== 'string' || !TASK_TYPES.includes(value.task as TaskType)) {
    throw new BadRequestException(`task must be one of: ${TASK_TYPES.join(', ')}`);
  }

  const topK = value.top_k === undefined ? undefined : boundedInteger(value.top_k, 'top_k', 1, 100);
  const sessionId = value.session_id === undefined ? undefined : value.session_id;
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > 200)) {
    throw new BadRequestException('session_id must be a string of at most 200 characters');
  }

  return {
    query: value.query.trim(),
    task: value.task as TaskType,
    top_k: topK,
    session_id: sessionId as string | undefined,
    retrieval: optionalOverrides(value.retrieval),
    embedding: parseEmbeddingOverride(value.embedding),
  };
}
