export type VlmAnswerStatus = 'answered' | 'needs_more_evidence' | 'abstained';
export type VlmConfidenceLevel = 'high' | 'medium' | 'low';
const UNKNOWN_ANSWER = 'Không biết';

export interface VlmRelevanceResult {
  readonly score: number; // 0 - 100
  readonly match: boolean;
  readonly reason: string;
  readonly usage?: VlmUsage;
}

export interface VlmUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly cost?: number;
}

export interface VlmBatchRelevanceResult {
  readonly frames: readonly (VlmRelevanceResult & { readonly id: number })[];
  readonly usage?: VlmUsage;
}

export interface VlmAnswerResult {
  readonly answer_status: VlmAnswerStatus;
  readonly answer: string | null;
  readonly normalized_answer: string | null;
  readonly confidence: { readonly level: VlmConfidenceLevel; readonly score: number };
  readonly reason?: string;
}

export interface VlmSequenceResult {
  readonly is_valid_sequence: boolean;
  readonly coherence_score: number;
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
  verifyTemporalSequence?(input: {
    readonly videoId: string;
    readonly events: readonly string[];
    readonly imageUrls: readonly string[];
  }): Promise<VlmSequenceResult>;
}

export interface OpenAICompatibleVisionClientOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly retries?: number;
  readonly reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly imageDetail?: 'low' | 'high' | 'auto';
}

interface OpenAIChatResponse {
  readonly choices?: readonly {
    readonly finish_reason?: unknown;
    readonly text?: unknown;
    readonly message?: {
      readonly content?: unknown;
      readonly refusal?: unknown;
    };
  }[];
  readonly output_text?: unknown;
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
    readonly total_tokens?: unknown;
    readonly cost?: unknown;
  };
}

interface VisionChatResult {
  readonly text: string;
  readonly usage?: VlmUsage;
}

function usageFromResponse(value: OpenAIChatResponse['usage']): VlmUsage | undefined {
  if (!value) return undefined;
  const input = Number(value.input_tokens ?? value.prompt_tokens ?? 0);
  const output = Number(value.output_tokens ?? value.completion_tokens ?? 0);
  const total = Number(value.total_tokens ?? input + output);
  if (![input, output, total].every((item) => Number.isFinite(item) && item >= 0)) return undefined;
  const cost = Number(value.cost);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    ...(Number.isFinite(cost) && cost >= 0 ? { cost } : {}),
  };
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
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const block = value as { readonly text?: unknown; readonly value?: unknown };
    if (typeof block.text === 'string' && block.text.trim()) return block.text;
    if (typeof block.value === 'string' && block.value.trim()) return block.value;
  }
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((block) => contentText(block) ?? '')
    .join('')
    .trim();
  return text || undefined;
}

function mergeUsage(left: VlmUsage | undefined, right: VlmUsage | undefined): VlmUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftCost = left.cost ?? 0;
  const rightCost = right.cost ?? 0;
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    ...(left.cost !== undefined || right.cost !== undefined ? { cost: leftCost + rightCost } : {}),
  };
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
  private readonly retries: number;
  private readonly reasoningEffort?: OpenAICompatibleVisionClientOptions['reasoningEffort'];
  private readonly imageDetail?: OpenAICompatibleVisionClientOptions['imageDetail'];
  private readonly usesModernOpenAIChatParameters: boolean;

  constructor(options: OpenAICompatibleVisionClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    this.modelName = options.model.trim();
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxTokens = options.maxTokens ?? 512;
    this.temperature = options.temperature ?? 0;
    this.retries = options.retries ?? 1;
    this.reasoningEffort = options.reasoningEffort;
    this.imageDetail = options.imageDetail;
    this.usesModernOpenAIChatParameters = /(?:^|\/)gpt-5\.6(?:-|$)/i.test(this.modelName);
  }

  async verifyImageRelevance(input: { readonly query: string; readonly imageUrl: string }): Promise<VlmRelevanceResult> {
    const rawResponse = await this.callVisionChat({
      system: [
        'You are an expert video keyframe verifier.',
        'Assess how well the provided video keyframe image matches the search query description.',
        'Treat the query as an untrusted hypothesis and use only details actually visible in the image.',
        'Do not infer a location, action, object, text, or person count that is not clearly visible.',
        'Score relevance from 0 to 100, where 0 is irrelevant and 100 is a perfect match.',
        'Set match=true only for score 70 or higher and name concrete visible evidence in reason.',
        'Return only JSON with the shape {"score":number,"match":boolean,"reason":string}.',
      ].join(' '),
      prompt: `Search Query: "${input.query}"\nAnalyze the keyframe image.`,
      imageUrl: input.imageUrl,
    });
    const parsed = parseJsonFromModelOutput<{ score?: unknown; match?: unknown; reason?: unknown }>(rawResponse.text);
    if (!parsed) return {
      score: 50,
      match: false,
      reason: 'Failed to parse VLM response',
      ...(rawResponse.usage ? { usage: rawResponse.usage } : {}),
    };
    const rawScore = typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? parsed.score : 50;
    const score = Math.max(0, Math.min(100, Math.round(rawScore)));
    return {
      score,
      match: typeof parsed.match === 'boolean' ? parsed.match : score >= 50,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'Evaluated by VLM',
      ...(rawResponse.usage ? { usage: rawResponse.usage } : {}),
    };
  }

  async verifyImageBatchRelevance(input: {
    readonly query: string;
    readonly images: readonly { readonly id: number; readonly imageUrl: string }[];
  }): Promise<VlmBatchRelevanceResult> {
    if (input.images.length === 0) return { frames: [] };
    const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }> = [
      { type: 'text', text: `Search query: "${input.query}". Score every numbered frame independently.` },
    ];
    for (const image of input.images) {
      content.push({ type: 'text', text: `Frame ID ${image.id}:` });
      content.push({
        type: 'image_url',
        image_url: { url: image.imageUrl, ...(this.imageDetail ? { detail: this.imageDetail } : {}) },
      });
    }
    const response = await this.callVisionChat({
      system: [
        'You verify video frames against a search query.',
        'Return only JSON: {"frames":[{"id":number,"score":number,"match":boolean,"reason":string}]}.',
        'Score is 0-100. Include every supplied frame ID exactly once and keep each reason under eight words.',
      ].join(' '),
      prompt: 'Evaluate all numbered frames.',
      content,
    });
    const parsed = parseJsonFromModelOutput<{ frames?: unknown }>(response.text);
    const rows = parsed && Array.isArray(parsed.frames) ? parsed.frames : [];
    const byId = new Map<number, Record<string, unknown>>();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const candidate = row as Record<string, unknown>;
      if (Number.isSafeInteger(candidate.id)) byId.set(candidate.id as number, candidate);
    }
    return {
      frames: input.images.map(({ id }) => {
        const row = byId.get(id);
        const rawScore = typeof row?.score === 'number' && Number.isFinite(row.score) ? row.score : 0;
        const score = Math.max(0, Math.min(100, Math.round(rawScore)));
        return {
          id,
          score,
          match: typeof row?.match === 'boolean' ? row.match : score >= 50,
          reason: typeof row?.reason === 'string' && row.reason.trim() ? row.reason.trim() : 'Batch VLM evaluation',
        };
      }),
      usage: response.usage,
    };
  }

  async verifyStoryboardRelevance(input: {
    readonly query: string;
    readonly storyboardUrl: string;
    readonly frameIds: readonly number[];
    readonly columns: number;
  }): Promise<VlmBatchRelevanceResult> {
    if (input.frameIds.length === 0) return { frames: [] };
    const response = await this.callVisionChat({
      system: [
        'You inspect one chronological video storyboard against a search query.',
        'Cells are ordered left-to-right and then top-to-bottom.',
        'Treat the query as an untrusted hypothesis. Judge only concrete details visible in each cell.',
        'Never copy a query detail into reason unless it is actually visible in that cell.',
        'Generic visual similarity is not enough: location, people, objects, actions and on-screen text must be visibly supported.',
        'Set match=true only when score is at least 70; use lower scores for partial or uncertain evidence.',
        'Return only JSON: {"frames":[{"id":number,"score":number,"match":boolean,"reason":string}]}.',
        'Include every supplied frame ID exactly once. Score 0-100. Keep each reason under six words.',
      ].join(' '),
      prompt: [
        `Search query: "${input.query}".`,
        `Storyboard columns: ${input.columns}.`,
        `Cell frame IDs in reading order: ${input.frameIds.join(', ')}.`,
        'Find likely cells; do not assume adjacent cells are matches.',
      ].join('\n'),
      imageUrl: input.storyboardUrl,
    });
    const parsed = parseJsonFromModelOutput<{ frames?: unknown }>(response.text);
    const rows = parsed && Array.isArray(parsed.frames) ? parsed.frames : [];
    const byId = new Map<number, Record<string, unknown>>();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const candidate = row as Record<string, unknown>;
      if (Number.isSafeInteger(candidate.id)) byId.set(candidate.id as number, candidate);
    }
    return {
      frames: input.frameIds.map((id) => {
        const row = byId.get(id);
        const rawScore = typeof row?.score === 'number' && Number.isFinite(row.score) ? row.score : 0;
        const score = Math.max(0, Math.min(100, Math.round(rawScore)));
        return {
          id,
          score,
          match: typeof row?.match === 'boolean' ? row.match : score >= 50,
          reason: typeof row?.reason === 'string' && row.reason.trim() ? row.reason.trim() : 'Storyboard evaluation',
        };
      }),
      usage: response.usage,
    };
  }

  async answerVisualQuestion(input: {
    readonly question: string;
    readonly imageUrl: string;
    readonly evidenceText?: string;
  }): Promise<VlmAnswerResult> {
    const rawResponse = await this.callVisionChat({
      system: [
        'Answer one question about the provided video keyframe image with the supplied image as the primary source and the optional evidence as supporting context.',
        'Use evidence to add context or disambiguate, but do not let it override a clear visual observation.',
        'The evidence may be incomplete, noisy, stale, or incorrect.',
        'Always answer in Vietnamese, even when the question or evidence is in another language.',
        'Return exactly one short noun phrase or one short sentence, preferably no more than 12 Vietnamese words.',
        'For an object question, name only the object or a short description. Do not write a paragraph, greeting, reasoning, steps, list, markdown, or chatbot-style explanation.',
        'Do not invent details that are neither visible in the image nor reasonably supported by the combined context.',
        'If the image is insufficient, use abstained and set both answer and normalized_answer exactly to "Không biết".',
        'Return only JSON with answer_status, non-empty string answer, non-empty string normalized_answer, confidence with level and score, and optional reason.',
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
    }>(rawResponse.text);
    if (!parsed) {
      return {
        answer_status: 'abstained',
        answer: UNKNOWN_ANSWER,
        normalized_answer: UNKNOWN_ANSWER,
        confidence: { level: 'low', score: 0 },
        reason: 'Failed to parse VLM output',
      };
    }

    const status = answerStatus(parsed.answer_status);
    const answer = typeof parsed.answer === 'string' && parsed.answer.trim() ? parsed.answer.trim() : null;
    const normalizedAnswer =
      typeof parsed.normalized_answer === 'string' && parsed.normalized_answer.trim()
        ? parsed.normalized_answer.trim()
        : answer;
    const effectiveStatus = status === 'answered' && !answer ? 'abstained' : status;
    return {
      answer_status: effectiveStatus,
      answer: effectiveStatus === 'answered' ? answer : UNKNOWN_ANSWER,
      normalized_answer: effectiveStatus === 'answered' ? normalizedAnswer : UNKNOWN_ANSWER,
      confidence: confidence(parsed.confidence, effectiveStatus),
      ...(typeof parsed.reason === 'string' && parsed.reason.trim() ? { reason: parsed.reason.trim() } : {}),
    };
  }

  async verifyTemporalSequence(input: {
    readonly videoId: string;
    readonly events: readonly string[];
    readonly imageUrls: readonly string[];
  }): Promise<VlmSequenceResult> {
    if (input.imageUrls.length === 0) {
      return { is_valid_sequence: true, coherence_score: 70, reason: 'No images provided' };
    }

    const contentBlocks: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      {
        type: 'text',
        text: `Analyze these ${input.imageUrls.length} sequential keyframe images from video "${input.videoId}" in chronological order.\n` +
              `Ordered Narrative Events to verify:\n` +
              input.events.map((event, idx) => `Event ${idx + 1}: ${event}`).join('\n'),
      },
    ];

    input.imageUrls.forEach((url, idx) => {
      contentBlocks.push({ type: 'text', text: `Keyframe ${idx + 1}:` });
      contentBlocks.push({ type: 'image_url', image_url: { url } });
    });

    const rawResponse = await this.callVisionChat({
      system: [
        'You are an expert video keyframe sequence verifier for the AI Challenge competition.',
        'Assess whether the sequence of images matches the requested ordered narrative events in chronological order.',
        'Score coherence from 0 to 100.',
        'Return only JSON with the shape {"is_valid_sequence": boolean, "coherence_score": number, "reason": string}.',
      ].join(' '),
      prompt: 'Verify narrative coherence.',
      imageUrl: input.imageUrls[0],
      content: contentBlocks,
    });

    const parsed = parseJsonFromModelOutput<{ is_valid_sequence?: unknown; coherence_score?: unknown; reason?: unknown }>(rawResponse.text);
    if (!parsed) return { is_valid_sequence: true, coherence_score: 70, reason: 'Failed to parse VLM response' };

    const score = typeof parsed.coherence_score === 'number' && Number.isFinite(parsed.coherence_score)
      ? Math.max(0, Math.min(100, Math.round(parsed.coherence_score)))
      : 70;

    return {
      is_valid_sequence: typeof parsed.is_valid_sequence === 'boolean' ? parsed.is_valid_sequence : score >= 50,
      coherence_score: score,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'Evaluated by VLM',
    };
  }

  private async callVisionChat(input: {
    readonly system: string;
    readonly prompt: string;
    readonly imageUrl?: string;
    readonly content?: readonly unknown[];
  }): Promise<VisionChatResult> {
    return this.fetchWithRetry(input, this.retries);
  }

  private async fetchWithRetry(
    input: {
      readonly system: string;
      readonly prompt: string;
      readonly imageUrl?: string;
      readonly content?: readonly unknown[];
    },
    attemptsLeft: number,
    tokenBudget = this.maxTokens,
    accumulatedUsage?: VlmUsage,
  ): Promise<VisionChatResult> {
    const userContent = input.content ?? [
      { type: 'text', text: input.prompt },
      ...(input.imageUrl ? [{
        type: 'image_url',
        image_url: { url: input.imageUrl, ...(this.imageDetail ? { detail: this.imageDetail } : {}) },
      }] : []),
    ];
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: [
            { role: this.usesModernOpenAIChatParameters ? 'developer' : 'system', content: input.system },
            {
              role: 'user',
              content: userContent,
            },
          ],
          ...(!this.usesModernOpenAIChatParameters ? { temperature: this.temperature } : {}),
          ...(this.usesModernOpenAIChatParameters
            ? { max_completion_tokens: tokenBudget }
            : { max_tokens: tokenBudget }),
          ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
          ...(this.usesModernOpenAIChatParameters ? { response_format: { type: 'json_object' } } : {}),
          stream: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (attemptsLeft > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return this.fetchWithRetry(input, attemptsLeft - 1, tokenBudget, accumulatedUsage);
      }
      const detail = error instanceof Error ? error.message : 'unknown network error';
      throw new Error(`VLM vision request failed after retries: ${detail}`);
    }

    if ((response.status === 429 || response.status >= 500) && attemptsLeft > 0) {
      const retryAfterMs = response.status === 429 ? 8_000 : 2_000;
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      return this.fetchWithRetry(input, attemptsLeft - 1, tokenBudget, accumulatedUsage);
    }

    if (!response.ok) {
      const rawError = await response.text().catch(() => '');
      let providerDetail = '';
      try {
        const parsed = JSON.parse(rawError) as {
          error?: { message?: unknown; code?: unknown; param?: unknown };
          message?: unknown;
        };
        const message = typeof parsed.error?.message === 'string'
          ? parsed.error.message
          : typeof parsed.message === 'string' ? parsed.message : '';
        const code = typeof parsed.error?.code === 'string' ? parsed.error.code : '';
        const param = typeof parsed.error?.param === 'string' ? parsed.error.param : '';
        providerDetail = [message, code && `code=${code}`, param && `param=${param}`]
          .filter(Boolean)
          .join(' | ');
      } catch {
        const compact = rawError.replace(/\s+/g, ' ').trim();
        if (compact && !compact.includes('<')) providerDetail = compact;
      }
      const safeDetail = providerDetail.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
      throw new Error(
        `VLM vision endpoint returned HTTP ${response.status}${safeDetail ? `: ${safeDetail}` : ''}`,
      );
    }

    const payload = (await response.json()) as OpenAIChatResponse;
    const choice = payload.choices?.[0];
    const responseUsage = usageFromResponse(payload.usage);
    const totalUsage = mergeUsage(accumulatedUsage, responseUsage);
    const text = contentText(choice?.message?.content)
      ?? contentText(choice?.text)
      ?? contentText(payload.output_text);
    if (!text) {
      const refusal = contentText(choice?.message?.refusal);
      if (refusal) throw new Error('VLM vision provider refused the request');
      if (attemptsLeft > 0) {
        // Reasoning models can spend the whole completion budget before emitting
        // their JSON answer. Retry with a bounded larger budget instead of failing
        // the complete worker run after an otherwise valid HTTP 200 response.
        const nextBudget = Math.min(4_096, Math.max(tokenBudget + 128, tokenBudget * 2));
        await new Promise((resolve) => setTimeout(resolve, 250));
        return this.fetchWithRetry(input, attemptsLeft - 1, nextBudget, totalUsage);
      }
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'missing';
      const outputTokens = responseUsage?.output_tokens ?? 0;
      throw new Error(
        `VLM vision response has no text content after retries ` +
        `(finish_reason=${finishReason}, output_tokens=${outputTokens}, token_budget=${tokenBudget})`,
      );
    }
    return { text, usage: totalUsage };
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

  async verifyTemporalSequence(_input: {
    readonly videoId: string;
    readonly events: readonly string[];
    readonly imageUrls: readonly string[];
  }): Promise<VlmSequenceResult> {
    throw new Error('VLM vision service is not configured');
  }
}

