import { Inject, Injectable, Logger } from '@nestjs/common';

import { LANGUAGE_MODEL } from '../common/tokens';
import { OpenAICompatibleLanguageModel, type LanguageModel } from '../compute/model-ports';
import type { QueryImprovementRequest } from './query-improver.request';

export interface QueryImprovementResponse {
  readonly original_query: string;
  readonly improved_query: string;
  readonly changed: boolean;
  readonly producer: string;
  readonly model_version: string;
  readonly warning: string | null;
}

interface QueryImprovementModelOutput {
  readonly improved_query?: unknown;
}

const MAX_QUERY_LENGTH = 2000;

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function parseModelOutput(value: string): QueryImprovementModelOutput | null {
  const candidate = stripCodeFence(value);
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as QueryImprovementModelOutput
      : null;
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as QueryImprovementModelOutput
        : null;
    } catch {
      return null;
    }
  }
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');
}

function eventLines(value: string): string[] {
  return value.split('\n')
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
}

function normalizeTrakeQuery(original: string, improved: string): string | null {
  const originalEvents = eventLines(original);
  const improvedEvents = eventLines(improved);
  if (originalEvents.length === 0 || originalEvents.length !== improvedEvents.length) return null;
  return improvedEvents.map((event, index) => `${index + 1}. ${event}`).join('\n');
}

function systemPrompt(task: QueryImprovementRequest['task']): string {
  const trakeInstruction = task === 'trake'
    ? 'For TRAKE, preserve the number of event lines and their order. Return one improved English event per numbered line.'
    : 'Return one improved query, not a list of alternatives.';
  return [
    'You are a video retrieval query improver.',
    'Read the Vietnamese query and rewrite it into precise, natural English for video keyframe retrieval.',
    'Preserve every fact and temporal relation from the original query; never invent details.',
    'Emphasize visually useful characteristics such as people, actions, objects, colors, appearance, locations, visible text, spoken content, and temporal relations.',
    trakeInstruction,
    'Return JSON only with exactly one field: {"improved_query":"..."}.',
  ].join(' ');
}

function fallback(
  request: QueryImprovementRequest,
  modelVersion: string,
  warning: string,
): QueryImprovementResponse {
  return {
    original_query: request.query,
    improved_query: request.query,
    changed: false,
    producer: 'query-improver-fallback',
    model_version: modelVersion,
    warning,
  };
}

@Injectable()
export class QueryImproverService {
  private readonly logger = new Logger(QueryImproverService.name);

  constructor(@Inject(LANGUAGE_MODEL) private readonly backendModel: LanguageModel) {}

  async improve(request: QueryImprovementRequest): Promise<QueryImprovementResponse> {
    const model = request.llm
      ? new OpenAICompatibleLanguageModel({
        baseUrl: request.llm.base_url,
        apiKey: request.llm.api_key,
        model: request.llm.model,
        timeoutMs: request.llm.timeout_ms,
        maxTokens: request.llm.max_tokens,
        temperature: request.llm.temperature,
      })
      : this.backendModel;

    if (!model.isConfigured) return fallback(request, model.modelName, 'query_improver_unavailable');

    let rawOutput: string;
    try {
      rawOutput = await model.complete({
        system: systemPrompt(request.task),
        prompt: `Task: ${request.task}\nOriginal Vietnamese query:\n${request.query}`,
      });
    } catch (error) {
      this.logger.warn(`query improvement failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return fallback(request, model.modelName, 'query_improver_failed');
    }

    const parsed = parseModelOutput(rawOutput);
    if (typeof parsed?.improved_query !== 'string') {
      return fallback(request, model.modelName, 'query_improver_invalid_output');
    }

    const rawImproved = parsed.improved_query.trim();
    if (!rawImproved || rawImproved.length > MAX_QUERY_LENGTH) {
      return fallback(request, model.modelName, 'query_improver_invalid_output');
    }

    const improved = request.task === 'trake'
      ? normalizeTrakeQuery(request.query, rawImproved)
      : normalizeQuery(rawImproved);
    if (!improved || improved.length > MAX_QUERY_LENGTH) {
      return fallback(request, model.modelName, 'query_improver_invalid_output');
    }

    return {
      original_query: request.query,
      improved_query: improved,
      changed: improved !== request.query,
      producer: 'query-improver-openai-compatible',
      model_version: model.modelName,
      warning: null,
    };
  }
}
