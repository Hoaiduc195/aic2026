export type VlmAnswerStatus = 'answered' | 'needs_more_evidence' | 'abstained';
export type VlmConfidenceLevel = 'high' | 'medium' | 'low';

export interface VlmRelevanceResult {
  readonly score: number;
  readonly match: boolean;
  readonly reason: string;
}

export interface VlmAnswerResult {
  readonly answer_status: VlmAnswerStatus;
  readonly answer: string | null;
  readonly normalized_answer: string | null;
  readonly confidence: { readonly level: VlmConfidenceLevel; readonly score: number };
  readonly reason?: string;
}

export interface VisionLanguageModel {
  readonly isConfigured: boolean;
  readonly modelName: string;
  verifyImageRelevance(input: { readonly query: string; readonly imageUrl: string }): Promise<VlmRelevanceResult>;
  answerVisualQuestion(input: {
    readonly question: string;
    readonly imageUrl: string;
    readonly evidenceText?: string;
  }): Promise<VlmAnswerResult>;
}

export interface OpenAICompatibleVisionClientOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

interface OpenAIChatResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
  }[];
}

function parseJsonFromModelOutput<T>(text: string): T | null {
  const candidate = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter((block): block is { readonly text?: unknown } => Boolean(block) && typeof block === 'object')
    .map((block) => typeof block.text === 'string' ? block.text : '')
    .join('')
    .trim();
  return text || undefined;
}

function answerStatus(value: unknown): VlmAnswerStatus {
  return value === 'answered' || value === 'needs_more_evidence' || value === 'abstained'
    ? value
    : 'abstained';
}

function confidence(value: unknown, status: VlmAnswerStatus): VlmAnswerResult['confidence'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { level: 'low', score: status === 'answered' ? 0.8 : 0.2 };
  }
  const raw = value as Record<string, unknown>;
  const level = raw.level === 'high' || raw.level === 'medium' || raw.level === 'low' ? raw.level : 'low';
  const rawScore = typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : status === 'answered' ? 0.8 : 0.2;
  return { level, score: Math.max(0, Math.min(1, rawScore)) };
}

export class OpenAICompatibleVisionClient implements VisionLanguageModel {
  readonly isConfigured = true;
  readonly modelName: string;
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(options: OpenAICompatibleVisionClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    this.modelName = options.model.trim();
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.maxTokens = options.maxTokens ?? 256;
    this.temperature = options.temperature ?? 0;
  }

  async verifyImageRelevance(input: { readonly query: string; readonly imageUrl: string }): Promise<VlmRelevanceResult> {
    const rawResponse = await this.callVisionChat({
      system: [
        'You are an expert video keyframe verifier.',
        'Assess how well the provided video keyframe image matches the search query description.',
        'Score relevance from 0 to 100, where 0 is irrelevant and 100 is a perfect match.',
        'Return only JSON with the shape {"score":number,"match":boolean,"reason":string}.',
      ].join(' '),
      prompt: `Search Query: "${input.query}"\nAnalyze the keyframe image.`,
      imageUrl: input.imageUrl,
    });
    const parsed = parseJsonFromModelOutput<{ score?: unknown; match?: unknown; reason?: unknown }>(rawResponse);
    if (!parsed) return { score: 50, match: false, reason: 'Failed to parse VLM response' };
    const rawScore = typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? parsed.score : 50;
    const score = Math.max(0, Math.min(100, Math.round(rawScore)));
    return {
      score,
      match: typeof parsed.match === 'boolean' ? parsed.match : score >= 50,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'Evaluated by VLM',
    };
  }

  async answerVisualQuestion(input: {
    readonly question: string;
    readonly imageUrl: string;
    readonly evidenceText?: string;
  }): Promise<VlmAnswerResult> {
    const rawResponse = await this.callVisionChat({
      system: [
        'Answer one question about the provided video keyframe image using visual inspection and optional grounded evidence.',
        'Answer concisely in the same language as the question.',
        'Do not invent facts that are not visible in the image or present in the evidence.',
        'Return only JSON with answer_status, answer, normalized_answer, confidence with level and score, and optional reason.',
      ].join(' '),
      prompt: input.evidenceText
        ? `Question: ${input.question}\nSupporting Text Evidence:\n${input.evidenceText}`
        : `Question: ${input.question}`,
      imageUrl: input.imageUrl,
    });
    const parsed = parseJsonFromModelOutput<{
      answer_status?: unknown;
      answer?: unknown;
      normalized_answer?: unknown;
      confidence?: unknown;
      reason?: unknown;
    }>(rawResponse);
    if (!parsed) {
      return {
        answer_status: 'abstained', answer: null, normalized_answer: null,
        confidence: { level: 'low', score: 0 }, reason: 'Failed to parse VLM output',
      };
    }

    const status = answerStatus(parsed.answer_status);
    const answer = typeof parsed.answer === 'string' && parsed.answer.trim() ? parsed.answer.trim() : null;
    const normalizedAnswer = typeof parsed.normalized_answer === 'string' && parsed.normalized_answer.trim()
      ? parsed.normalized_answer.trim()
      : answer;
    return {
      answer_status: status,
      answer,
      normalized_answer: normalizedAnswer,
      confidence: confidence(parsed.confidence, status),
      ...(typeof parsed.reason === 'string' && parsed.reason.trim() ? { reason: parsed.reason.trim() } : {}),
    };
  }

  private async callVisionChat(input: {
    readonly system: string;
    readonly prompt: string;
    readonly imageUrl: string;
  }): Promise<string> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.modelName,
        messages: [
          { role: 'system', content: input.system },
          {
            role: 'user',
            content: [
              { type: 'text', text: input.prompt },
              { type: 'image_url', image_url: { url: input.imageUrl } },
            ],
          },
        ],
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`VLM vision endpoint returned HTTP ${response.status}`);
    const payload = await response.json() as OpenAIChatResponse;
    const text = contentText(payload.choices?.[0]?.message?.content);
    if (!text) throw new Error('VLM vision response has no text content');
    return text;
  }
}

export class UnavailableVisionLanguageModel implements VisionLanguageModel {
  readonly isConfigured = false;
  readonly modelName = 'unconfigured';

  async verifyImageRelevance(_input: { readonly query: string; readonly imageUrl: string }): Promise<VlmRelevanceResult> {
    throw new Error('VLM vision service is not configured');
  }

  async answerVisualQuestion(_input: {
    readonly question: string;
    readonly imageUrl: string;
    readonly evidenceText?: string;
  }): Promise<VlmAnswerResult> {
    throw new Error('VLM vision service is not configured');
  }
}
