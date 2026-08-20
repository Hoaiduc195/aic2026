import { Inject, Injectable, Logger } from '@nestjs/common';

import { LANGUAGE_MODEL } from '../common/tokens';
import { OpenAICompatibleLanguageModel, type LanguageModel } from '../compute/model-ports';
import type { QueryImprovementRequest } from './query-improver.request';

export interface QueryImprovementResponse {
  readonly original_query: string;
  readonly improved_query: string;
  readonly original_question?: string;
  readonly improved_question?: string;
  readonly changed: boolean;
  readonly producer: string;
  readonly model_version: string;
  readonly warning: string | null;
}

interface QueryImprovementModelOutput {
  readonly improved_query?: unknown;
  readonly improved_question?: unknown;
  readonly query?: unknown;
  readonly question?: unknown;
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

interface TrakeQueryParts {
  readonly overview: string | null;
  readonly events: string[];
}

function parseTrakeQuery(value: string): TrakeQueryParts | null {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstEventIndex = lines.findIndex((line) => /^\d+[.)]\s*/.test(line));
  if (firstEventIndex < 0) return null;

  const overview = firstEventIndex === 0 ? null : lines.slice(0, firstEventIndex).join('\n').trim();
  const eventLines = lines.slice(firstEventIndex);
  if (eventLines.some((line) => !/^\d+[.)]\s*/.test(line))) return null;
  const events = eventLines
    .map((line) => line.replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean);
  return events.length > 0 ? { overview, events } : null;
}

function plainTextImprovedQuery(
  value: string,
  task: QueryImprovementRequest['task'],
): string | null {
  const candidate = stripCodeFence(value);
  if (!candidate || candidate.startsWith('{') || candidate.startsWith('[')) return null;
  if (task === 'trake' && !parseTrakeQuery(candidate)) return null;
  return candidate;
}

interface VqaPlainTextOutput {
  readonly improvedQuery: string;
  readonly improvedQuestion: string;
}

type VqaOutputField = 'improvedQuery' | 'improvedQuestion';

function vqaOutputField(line: string): { readonly field: VqaOutputField; readonly value: string } | null {
  const label = line.match(/^\s*(?:\*\*\s*)?(?:improved\s+)?(query|description|truy\s*vấn|question|câu\s*hỏi)(?:\s*\*\*)?\s*[:\-]?\s*(.*)$/i);
  if (!label) return null;
  const field = /^(query|description|truy\s*vấn)$/i.test(label[1])
    ? 'improvedQuery'
    : 'improvedQuestion';
  return { field, value: label[2].trim() };
}

function parseVqaPlainTextOutput(value: string): VqaPlainTextOutput | null {
  const values: Partial<Record<VqaOutputField, string[]>> = {};
  let currentField: VqaOutputField | null = null;

  for (const line of stripCodeFence(value).split(/\r?\n/)) {
    const labeled = vqaOutputField(line);
    if (labeled) {
      currentField = labeled.field;
      values[currentField] = labeled.value ? [labeled.value] : [];
    } else if (currentField && line.trim()) {
      values[currentField] = [...(values[currentField] ?? []), line.trim()];
    }
  }

  const improvedQuery = values.improvedQuery?.join('\n').trim();
  const improvedQuestion = values.improvedQuestion?.join('\n').trim();
  return improvedQuery && improvedQuestion ? { improvedQuery, improvedQuestion } : null;
}

function normalizeTrakeQuery(original: string, improved: string): string | null {
  const originalParts = parseTrakeQuery(original);
  const improvedParts = parseTrakeQuery(improved);
  if (!originalParts || !improvedParts || originalParts.events.length !== improvedParts.events.length) return null;
  if (originalParts.overview !== null && improvedParts.overview === null) return null;

  return [
    ...(improvedParts.overview === null ? [] : [improvedParts.overview]),
    ...improvedParts.events.map((event, index) => `${index + 1}. ${event}`),
  ].join('\n');
}

function systemPrompt(task: QueryImprovementRequest['task']): string {
  const trakeInstruction = task === 'trake'
    ? 'For TRAKE, preserve the overall query before the numbered lines, then preserve the number and order of event lines. Return one improved English overall query first and one improved English event per numbered line. If JSON mode is unavailable, return exactly that structured text without markdown or commentary.'
    : 'Return one improved query, not a list of alternatives.';
  const outputInstruction = task === 'vqa'
    ? 'For VQA, improve the event query and the question independently. Prefer JSON with exactly two fields: {"improved_query":"...","improved_question":"..."}. If JSON mode is unavailable, return exactly two labeled lines: Improved query: ... and Improved question: ... . Do not add commentary.'
    : 'Prefer JSON with exactly one field: {"improved_query":"..."}. If JSON mode is unavailable, return only the improved query text in the required structure, without JSON or commentary.';
  return [
    'You are a video retrieval query improver.',
    'Read the Vietnamese query and rewrite it into precise, natural English for video keyframe retrieval.',
    'Preserve every fact and temporal relation from the original query; never invent details.',
    'Emphasize visually useful characteristics such as people, actions, objects, colors, appearance, locations, visible text, spoken content, and temporal relations.',
    trakeInstruction,
    outputInstruction,
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
    ...(request.question === undefined ? {} : {
      original_question: request.question,
      improved_question: request.question,
    }),
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
        prompt: [
          `Task: ${request.task}`,
          `Original Vietnamese query:\n${request.query}`,
          ...(request.task === 'vqa' ? [`Original Vietnamese question:\n${request.question ?? ''}`] : []),
        ].join('\n'),
      });
    } catch (error) {
      this.logger.warn(`query improvement failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return fallback(request, model.modelName, 'query_improver_failed');
    }

    const parsed = parseModelOutput(rawOutput);
    const plainVqaOutput = request.task === 'vqa' ? parseVqaPlainTextOutput(rawOutput) : null;
    const rawImprovedValue = typeof parsed?.improved_query === 'string'
      ? parsed.improved_query
      : request.task === 'vqa' && typeof parsed?.query === 'string'
        ? parsed.query
        : plainVqaOutput?.improvedQuery
          ?? (request.task === 'vqa' ? null : plainTextImprovedQuery(rawOutput, request.task));
    if (rawImprovedValue === null) {
      return fallback(request, model.modelName, 'query_improver_invalid_output');
    }

    const rawImproved = stripCodeFence(rawImprovedValue);
    if (!rawImproved || rawImproved.length > MAX_QUERY_LENGTH) {
      return fallback(request, model.modelName, 'query_improver_invalid_output');
    }

    let improvedQuestion: string | undefined;
    if (request.task === 'vqa') {
      const rawImprovedQuestionValue = typeof parsed?.improved_question === 'string'
        ? parsed.improved_question
        : typeof parsed?.question === 'string'
          ? parsed.question
          : plainVqaOutput?.improvedQuestion;
      if (!request.question || typeof rawImprovedQuestionValue !== 'string') {
        return fallback(request, model.modelName, 'query_improver_invalid_output');
      }
      const rawImprovedQuestion = rawImprovedQuestionValue.trim();
      improvedQuestion = normalizeQuery(rawImprovedQuestion);
      if (!improvedQuestion || improvedQuestion.length > MAX_QUERY_LENGTH) {
        return fallback(request, model.modelName, 'query_improver_invalid_output');
      }
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
      ...(request.question === undefined || improvedQuestion === undefined ? {} : {
        original_question: request.question,
        improved_question: improvedQuestion,
      }),
      changed: improved !== request.query || (request.question !== undefined && improvedQuestion !== request.question),
      producer: 'query-improver-openai-compatible',
      model_version: model.modelName,
      warning: null,
    };
  }
}
