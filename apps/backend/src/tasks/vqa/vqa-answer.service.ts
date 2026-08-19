import {
  BadGatewayException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { LANGUAGE_MODEL, OBJECT_STORAGE, VISION_LANGUAGE_MODEL, VQA_GROUNDING_REPOSITORY } from '../../common/tokens';
import { fetchImageAsDataUrl } from '../../compute/image-data-url';
import { OpenAICompatibleLanguageModel, type LanguageModel } from '../../compute/model-ports';
import { OpenAICompatibleVisionClient, type VisionLanguageModel, type VlmAnswerResult } from '../../compute/vlm-vision.client';
import type { ObjectStorage } from '../../storage/object-storage';
import type { VqaAnswerRequest } from './vqa-answer.request';
import type { VqaGroundingEvidence, VqaGroundingRepository } from './vqa-grounding.repository';

export type VqaAnswerStatus = 'answered' | 'needs_more_evidence' | 'abstained';
export type VqaConfidenceLevel = 'low' | 'medium' | 'high';

export interface VqaAnswerResponse {
  readonly result_id: string;
  readonly query_id: string;
  readonly video_id: string;
  readonly original_frame_id: number;
  readonly timestamp_ms: number;
  readonly answer_status: VqaAnswerStatus;
  readonly answer: string | null;
  readonly normalized_answer: string | null;
  readonly evidence_ids: readonly string[];
  readonly confidence: { readonly level: VqaConfidenceLevel; readonly score: number };
  readonly producer: string;
  readonly model_version: string;
  readonly verification?: Readonly<Record<string, unknown>>;
}

interface ModelAnswer {
  readonly answer_status?: unknown;
  readonly answer?: unknown;
  readonly normalized_answer?: unknown;
  readonly confidence?: unknown;
}

const PRODUCER = 'llm-vqa-openai-compatible';
const VLM_PRODUCER = 'vlm-vision-openai-compatible';
const MAX_EVIDENCE = 20;
const MAX_SNIPPET_LENGTH = 500;
const MAX_PROMPT_LENGTH = 8_000;

function baseResponse(
  request: VqaAnswerRequest,
  context: { readonly timestamp_ms: number },
  modelVersion: string,
  evidenceIds: readonly string[],
  answerStatus: VqaAnswerStatus,
  verification: Readonly<Record<string, unknown>>,
  answer: string | null = null,
  normalizedAnswer: string | null = null,
  confidence: { readonly level: VqaConfidenceLevel; readonly score: number } = { level: 'low', score: 0 },
  producer: string = PRODUCER,
): VqaAnswerResponse {
  return {
    result_id: randomUUID(),
    query_id: request.query_id,
    video_id: request.video_id,
    original_frame_id: request.original_frame_id,
    timestamp_ms: context.timestamp_ms,
    answer_status: answerStatus,
    answer,
    normalized_answer: normalizedAnswer,
    evidence_ids: [...evidenceIds],
    confidence,
    producer,
    model_version: modelVersion,
    verification,
  };
}

function compactEvidence(evidence: readonly VqaGroundingEvidence[]): { rows: readonly VqaGroundingEvidence[]; text: string } {
  const rows: VqaGroundingEvidence[] = [];
  let text = '';
  for (const item of evidence.slice(0, MAX_EVIDENCE)) {
    const snippet = item.snippet?.trim().slice(0, MAX_SNIPPET_LENGTH);
    if (!snippet) continue;
    const row = { ...item, snippet };
    const line = `[${row.type}][${row.evidence_id}] ${snippet}`;
    if (text.length + line.length + 1 > MAX_PROMPT_LENGTH) break;
    rows.push(row);
    text += `${text ? '\n' : ''}${line}`;
  }
  return { rows, text };
}

function parseModelOutput(value: string): ModelAnswer | null {
  const candidate = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ModelAnswer : null;
  } catch {
    return null;
  }
}

function confidence(value: unknown): { readonly level: VqaConfidenceLevel; readonly score: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { level: 'low', score: 0 };
  const raw = value as Record<string, unknown>;
  const level = raw.level === 'high' || raw.level === 'medium' || raw.level === 'low' ? raw.level : 'low';
  const numericScore = typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : 0;
  return { level, score: Math.max(0, Math.min(1, numericScore)) };
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

@Injectable()
export class VqaAnswerService {
  constructor(
    @Inject(VQA_GROUNDING_REPOSITORY) private readonly grounding: VqaGroundingRepository,
    @Inject(LANGUAGE_MODEL) private readonly languageModel: LanguageModel,
    @Optional() @Inject(VISION_LANGUAGE_MODEL) private readonly vlm?: VisionLanguageModel,
    @Optional() @Inject(OBJECT_STORAGE) private readonly storage?: ObjectStorage,
  ) {}

  async answer(request: VqaAnswerRequest): Promise<VqaAnswerResponse> {
    const context = await this.grounding.find(request.query_id, request.video_id, request.original_frame_id);
    if (!context) throw new NotFoundException('VQA query or frame was not found');

    const selectedEvidence = compactEvidence(context.evidence);

    const visionModel = request.vlm
      ? new OpenAICompatibleVisionClient({
        baseUrl: request.vlm.base_url,
        apiKey: request.vlm.api_key,
        model: request.vlm.model,
        timeoutMs: request.vlm.timeout_ms,
        maxTokens: request.vlm.max_tokens,
        temperature: request.vlm.temperature,
      })
      : this.vlm;
    let imageDataUrl: string | undefined;
    if (context.thumbnail_object_key && this.storage?.isConfigured) {
      try {
        const signedUrl = await this.storage.signReadUrl(context.thumbnail_object_key);
        imageDataUrl = await fetchImageAsDataUrl(signedUrl);
      } catch {
        imageDataUrl = undefined;
      }
    }
    let visualResult: VlmAnswerResult | undefined;
    if (visionModel?.isConfigured && imageDataUrl) {
      try {
        visualResult = await visionModel.answerVisualQuestion({
          question: request.question,
          imageUrl: imageDataUrl,
          evidenceText: selectedEvidence.text || undefined,
        });
        if (visualResult.answer_status === 'answered' && visualResult.answer) {
          return baseResponse(
            request,
            context,
            visionModel.modelName,
            selectedEvidence.rows.map((item) => item.evidence_id),
            'answered',
            { reason: visualResult.reason ?? 'grounded_vlm_visual_answer' },
            visualResult.answer,
            visualResult.normalized_answer || visualResult.answer,
            visualResult.confidence,
            VLM_PRODUCER,
          );
        }
      } catch {
        visualResult = undefined;
      }
    }

    const languageModel = request.llm
      ? new OpenAICompatibleLanguageModel({
        baseUrl: request.llm.base_url,
        apiKey: request.llm.api_key,
        model: request.llm.model,
        timeoutMs: request.llm.timeout_ms,
        maxTokens: request.llm.max_tokens,
        temperature: request.llm.temperature,
      })
      : this.languageModel;
    if (!languageModel.isConfigured) {
      if (visualResult) {
        return baseResponse(
          request,
          context,
          visionModel?.modelName ?? 'unconfigured',
          selectedEvidence.rows.map((item) => item.evidence_id),
          visualResult.answer_status,
          { reason: visualResult.reason ?? 'vlm_abstained' },
          visualResult.answer,
          visualResult.normalized_answer,
          visualResult.confidence,
          VLM_PRODUCER,
        );
      }
      throw new ServiceUnavailableException('LLM answer service is not configured');
    }

    if (selectedEvidence.rows.length === 0) {
      return baseResponse(request, context, languageModel.modelName, [], 'abstained', {
        reason: 'no_grounded_evidence',
      });
    }

    const system = [
      'Answer one video question by inspecting the supplied keyframe image as the primary source.',
      'Treat the accompanying text evidence as supporting reference only; it may be incomplete, noisy, stale, or incorrect.',
      'Use evidence to provide context or disambiguate, but do not let it override a clear visual observation.',
      'Do not invent details that are neither visible in the image nor reasonably supported by the combined context.',
      'Answer in the same language as the question.',
      'If the image and supporting context are insufficient, use needs_more_evidence or abstained.',
      'Return JSON only. Every key is mandatory and must be present: answer_status must be exactly answered, needs_more_evidence, or abstained; answer must be a string or null; normalized_answer must be a string or null; confidence must be an object with level and score.',
    ].join(' ');
    const prompt = `Question: ${request.question}\nEvidence:\n${selectedEvidence.text}`;

    let output: string;
    try {
      output = await languageModel.complete({
        system,
        prompt,
        ...(imageDataUrl ? { imageDataUrl } : {}),
      });
    } catch {
      throw new BadGatewayException('LLM answer service failed');
    }
    const parsed = parseModelOutput(output);
    if (!parsed) {
      return baseResponse(request, context, languageModel.modelName,
        selectedEvidence.rows.map((item) => item.evidence_id), 'abstained', { reason: 'invalid_model_output' });
    }

    const status = parsed.answer_status === 'answered'
      || parsed.answer_status === 'needs_more_evidence'
      || parsed.answer_status === 'abstained' ? parsed.answer_status : 'abstained';
    const answer = typeof parsed.answer === 'string' ? normalized(parsed.answer) : '';
    const normalizedAnswer = typeof parsed.normalized_answer === 'string' ? normalized(parsed.normalized_answer) : answer;
    if (status !== 'answered' || !answer) {
      return baseResponse(request, context, languageModel.modelName,
        selectedEvidence.rows.map((item) => item.evidence_id), status === 'needs_more_evidence' ? status : 'abstained', {
          reason: status === 'needs_more_evidence' ? 'model_requested_more_evidence' : 'model_abstained',
        }, null, null, confidence(parsed.confidence));
    }

    return baseResponse(request, context, languageModel.modelName,
      selectedEvidence.rows.map((item) => item.evidence_id), 'answered', { reason: 'grounded_model_answer' },
      answer, normalizedAnswer || answer, confidence(parsed.confidence));
  }
}
