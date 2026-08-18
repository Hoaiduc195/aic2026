export interface VlmRelevanceResult {
  readonly score: number; // 0 - 100
  readonly match: boolean;
  readonly reason: string;
}

export interface VlmAnswerResult {
  readonly answer_status: 'answered' | 'needs_more_evidence' | 'abstained';
  readonly answer: string | null;
  readonly normalized_answer: string | null;
  readonly confidence: { readonly level: 'high' | 'medium' | 'low'; readonly score: number };
  readonly reason?: string;
}

export interface VisionLanguageModel {
  readonly isConfigured: boolean;
  readonly modelName: string;
  verifyImageRelevance(input: { readonly query: string; readonly imageUrl: string }): Promise<VlmRelevanceResult>;
  answerVisualQuestion(input: { readonly question: string; readonly imageUrl: string; readonly evidenceText?: string }): Promise<VlmAnswerResult>;
}

export interface OpenAICompatibleVisionClientOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly retries?: number;
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
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter((block): block is { readonly text?: unknown } => Boolean(block) && typeof block === 'object')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim();
  return text || undefined;
}

export class OpenAICompatibleVisionClient implements VisionLanguageModel {
  readonly isConfigured = true;
  readonly modelName: string;
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly retries: number;

  constructor(options: OpenAICompatibleVisionClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    this.modelName = options.model.trim();
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    // 512 tokens gives headroom for verbose JSON reason fields from Gemini
    this.maxTokens = options.maxTokens ?? 512;
    this.temperature = options.temperature ?? 0;
    // 1 retry to handle free-tier 429 rate-limit bursts gracefully
    this.retries = options.retries ?? 1;
  }

  async verifyImageRelevance(input: { readonly query: string; readonly imageUrl: string }): Promise<VlmRelevanceResult> {
    // Concise system prompt: Gemini-3.x performs better with direct, unambiguous instructions
    const system =
      'You are a visual relevance scorer for video keyframes. ' +
      'Given a search query and a keyframe image, rate how well the image matches the query. ' +
      'Respond ONLY with a JSON object — no markdown, no prose: ' +
      '{"score": <integer 0-100>, "match": <boolean>, "reason": <one-sentence string>}';

    const prompt = `Query: "${input.query}"\nScore this keyframe image.`;

    const rawResponse = await this.callVisionChat({
      system,
      prompt,
      imageUrl: input.imageUrl,
    });

    const parsed = parseJsonFromModelOutput<{ score?: unknown; match?: unknown; reason?: unknown }>(rawResponse);
    if (!parsed) {
      return { score: 50, match: false, reason: 'Failed to parse VLM response' };
    }

    const rawScore = typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? parsed.score : 50;
    const score = Math.max(0, Math.min(100, Math.round(rawScore)));
    const match = typeof parsed.match === 'boolean' ? parsed.match : score >= 50;
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : 'Evaluated by VLM';

    return { score, match, reason };
  }

  async answerVisualQuestion(input: {
    readonly question: string;
    readonly imageUrl: string;
    readonly evidenceText?: string;
  }): Promise<VlmAnswerResult> {
    // Direct, schema-anchored prompt yields cleaner JSON from Gemini-3.x
    const system =
      'You answer a single question about a video keyframe image. ' +
      'Use visual evidence from the image and any supplied text evidence. ' +
      'Answer in the same language as the question. ' +
      'Respond ONLY with a JSON object — no markdown: ' +
      '{"answer_status":"answered|needs_more_evidence|abstained","answer":string|null,' +
      '"normalized_answer":string|null,"confidence":{"level":"high|medium|low","score":number},"reason":string}';

    const promptText = input.evidenceText
      ? `Question: ${input.question}\nSupporting Text Evidence:\n${input.evidenceText}`
      : `Question: ${input.question}`;

    const rawResponse = await this.callVisionChat({
      system,
      prompt: promptText,
      imageUrl: input.imageUrl,
    });

    const parsed = parseJsonFromModelOutput<{
      answer_status?: unknown;
      answer?: unknown;
      normalized_answer?: unknown;
      confidence?: { level?: unknown; score?: unknown };
      reason?: unknown;
    }>(rawResponse);

    if (!parsed) {
      return {
        answer_status: 'abstained',
        answer: null,
        normalized_answer: null,
        confidence: { level: 'low', score: 0 },
        reason: 'Failed to parse VLM output',
      };
    }

    const answerStatus =
      parsed.answer_status === 'answered' ||
      parsed.answer_status === 'needs_more_evidence' ||
      parsed.answer_status === 'abstained'
        ? parsed.answer_status
        : 'abstained';

    const answer = typeof parsed.answer === 'string' && parsed.answer.trim() ? parsed.answer.trim() : null;
    const normalizedAnswer =
      typeof parsed.normalized_answer === 'string' && parsed.normalized_answer.trim()
        ? parsed.normalized_answer.trim()
        : answer;

    const confLevel =
      parsed.confidence?.level === 'high' ||
      parsed.confidence?.level === 'medium' ||
      parsed.confidence?.level === 'low'
        ? parsed.confidence.level
        : 'low';
    const confScore =
      typeof parsed.confidence?.score === 'number' && Number.isFinite(parsed.confidence.score)
        ? Math.max(0, Math.min(1, parsed.confidence.score))
        : answerStatus === 'answered'
          ? 0.8
          : 0.2;

    return {
      answer_status: answerStatus,
      answer,
      normalized_answer: normalizedAnswer,
      confidence: { level: confLevel, score: confScore },
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  }

  private async callVisionChat(input: {
    readonly system: string;
    readonly prompt: string;
    readonly imageUrl: string;
  }): Promise<string> {
    return this.fetchWithRetry(input, this.retries);
  }

  private async fetchWithRetry(
    input: { readonly system: string; readonly prompt: string; readonly imageUrl: string },
    attemptsLeft: number,
  ): Promise<string> {
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
        // max_completion_tokens is the preferred param for Gemini 3.x via OpenAI-compat endpoint
        max_completion_tokens: this.maxTokens,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    // Retry on 429 (rate limit) or 5xx (transient server errors)
    if ((response.status === 429 || response.status >= 500) && attemptsLeft > 0) {
      const retryAfterMs = response.status === 429 ? 8_000 : 2_000;
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      return this.fetchWithRetry(input, attemptsLeft - 1);
    }

    if (!response.ok) {
      throw new Error(`VLM Vision endpoint returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as OpenAIChatResponse;
    const text = contentText(payload.choices?.[0]?.message?.content);
    if (!text) throw new Error('VLM Vision response has no text content');
    return text;
  }
}

export class UnavailableVisionLanguageModel implements VisionLanguageModel {
  readonly isConfigured = false;
  readonly modelName = 'unconfigured';

  async verifyImageRelevance(): Promise<VlmRelevanceResult> {
    throw new Error('VLM Vision service is not configured');
  }

  async answerVisualQuestion(): Promise<VlmAnswerResult> {
    throw new Error('VLM Vision service is not configured');
  }
}
