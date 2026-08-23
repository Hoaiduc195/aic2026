import type { EmbeddingConfig } from './types.js';
import { safeBackendUrl, safeEmbeddingUrl } from './validation.js';

export interface AppConfig {
  readonly backendUrl: string;
  readonly operatorToken?: string;
  readonly requestTimeoutMs: number;
  readonly maxResults: number;
  readonly maxNearbyFrames: number;
  readonly maxImageBytes: number;
  readonly maxLoopIterations: number;
  readonly maxLoopToolCalls: number;
  readonly loopTimeBudgetMs: number;
  readonly embedding?: EmbeddingConfig;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  return boundedInteger(value, fallback, 1, maximum, 'configuration value');
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== '')?.trim();
}

function loadEmbeddingConfig(environment: NodeJS.ProcessEnv): EmbeddingConfig | undefined {
  const baseUrl = firstNonBlank(environment.MCP_EMBEDDING_SERVICE_URL, environment.EMBEDDING_SERVICE_URL);
  const apiKey = firstNonBlank(environment.MCP_EMBEDDING_SERVICE_TOKEN, environment.EMBEDDING_SERVICE_TOKEN);
  const timeout = firstNonBlank(environment.MCP_EMBEDDING_TIMEOUT_MS);
  if (!baseUrl && !apiKey && !timeout) return undefined;
  if (!baseUrl) throw new Error('MCP_EMBEDDING_SERVICE_URL is required when embedding configuration is set');
  if (apiKey && apiKey.length > 1000) throw new Error('MCP embedding service token must be at most 1000 characters');

  return {
    baseUrl: safeEmbeddingUrl(baseUrl),
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: boundedInteger(timeout, 5000, 100, 120_000, 'MCP_EMBEDDING_TIMEOUT_MS'),
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const embedding = loadEmbeddingConfig(environment);
  return {
    backendUrl: safeBackendUrl(environment.AIC_BACKEND_URL ?? 'http://localhost:4000'),
    ...(environment.AIC_OPERATOR_TOKEN?.trim()
      ? { operatorToken: environment.AIC_OPERATOR_TOKEN.trim() }
      : {}),
    requestTimeoutMs: positiveInteger(environment.MCP_REQUEST_TIMEOUT_MS, 15_000, 60_000),
    maxResults: positiveInteger(environment.MCP_MAX_RESULTS, 20, 100),
    maxNearbyFrames: positiveInteger(environment.MCP_MAX_NEARBY_FRAMES, 25, 100),
    maxImageBytes: positiveInteger(environment.MCP_MAX_IMAGE_BYTES, 12 * 1024 * 1024, 12 * 1024 * 1024),
    maxLoopIterations: positiveInteger(environment.MCP_MAX_LOOP_ITERATIONS, 5, 8),
    maxLoopToolCalls: positiveInteger(environment.MCP_MAX_LOOP_TOOL_CALLS, 30, 50),
    loopTimeBudgetMs: positiveInteger(environment.MCP_LOOP_TIME_BUDGET_MS, 60_000, 120_000),
    ...(embedding ? { embedding } : {}),
  };
}
