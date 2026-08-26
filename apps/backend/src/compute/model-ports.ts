export interface QueryEmbeddingProvider {
  readonly isConfigured: boolean;
  readonly dimensions: number;
  embedText(query: string): Promise<readonly number[]>;
  embedImage?(image: Uint8Array, mimeType: string): Promise<readonly number[]>;
}

export interface LanguageModel {
  readonly isConfigured: boolean;
  readonly modelName: string;
  complete(input: {
    readonly system: string;
    readonly prompt: string;
    readonly imageDataUrl?: string;
  }): Promise<string>;
}

export interface TemporalAligner {
  align(input: { readonly events: readonly string[]; readonly candidateIds: readonly string[] }): Promise<readonly string[]>;
}

export class HttpQueryEmbeddingProvider implements QueryEmbeddingProvider {
  readonly isConfigured = true;
  private readonly textCache = new Map<string, readonly number[]>();
  private readonly inFlightText = new Map<string, Promise<readonly number[]>>();
  private readonly maxCachedQueries = 256;
  private textQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly endpoint: string,
    public readonly dimensions: number,
    private readonly bearerToken?: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async embedText(query: string): Promise<readonly number[]> {
    const cacheKey = query.normalize('NFKC').trim();
    const cached = this.textCache.get(cacheKey);
    if (cached) {
      this.textCache.delete(cacheKey);
      this.textCache.set(cacheKey, cached);
      return cached;
    }
    const inFlight = this.inFlightText.get(cacheKey);
    if (inFlight) return inFlight;

    const request = this.enqueueTextEmbedding(query)
      .then((embedding) => {
        this.textCache.set(cacheKey, embedding);
        while (this.textCache.size > this.maxCachedQueries) {
          const oldest = this.textCache.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.textCache.delete(oldest);
        }
        return embedding;
      })
      .finally(() => this.inFlightText.delete(cacheKey));
    this.inFlightText.set(cacheKey, request);
    return request;
  }

  private enqueueTextEmbedding(query: string): Promise<readonly number[]> {
    const request = this.textQueue.then(() => this.fetchTextEmbedding(query));
    this.textQueue = request.then(() => undefined, () => undefined);
    return request;
  }

  private async fetchTextEmbedding(query: string): Promise<readonly number[]> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
      },
      body: JSON.stringify({ text: query }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`embedding service returned HTTP ${response.status}`);
    const payload = await response.json() as { embedding?: unknown };
    return this.parseEmbedding(payload.embedding);
  }

  async embedImage(image: Uint8Array, mimeType: string): Promise<readonly number[]> {
    const normalizedMimeType = mimeType.split(';', 1)[0]?.trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(normalizedMimeType)) {
      throw new Error('image embedding requires a supported image MIME type');
    }
    if (image.byteLength === 0 || image.byteLength > 12 * 1024 * 1024) {
      throw new Error('image embedding input must be between 1 byte and 12 MiB');
    }
    const baseEndpoint = this.endpoint.replace(/\/+$/, '');
    const endpoint = baseEndpoint.endsWith('/image') ? baseEndpoint : `${baseEndpoint}/image`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': normalizedMimeType,
        ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
      },
      body: image as unknown as BodyInit,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`embedding service returned HTTP ${response.status}`);
    const payload = await response.json() as { embedding?: unknown };
    return this.parseEmbedding(payload.embedding);
  }

  private parseEmbedding(value: unknown): readonly number[] {
    if (!Array.isArray(value) || value.length !== this.dimensions
      || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
      throw new Error(`embedding service must return ${this.dimensions} finite numbers`);
    }
    return value as number[];
  }
}

export class UnavailableQueryEmbeddingProvider implements QueryEmbeddingProvider {
  readonly isConfigured = false;
  constructor(public readonly dimensions = 1024) {}
  async embedText(_query: string): Promise<readonly number[]> { throw new Error('query embedding service is not configured'); }
  async embedImage(_image: Uint8Array, _mimeType: string): Promise<readonly number[]> {
    throw new Error('query embedding service is not configured');
  }
}

export interface OpenAICompatibleLanguageModelOptions {
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

const JSON_MODE_FALLBACK_STATUSES = new Set([400, 404, 422, 501]);
const LLM_MAX_RETRIES = 5;
const LLM_RETRY_BASE_DELAY_MS = 250;

function isRetryableStatus(status: number): boolean {
  if (JSON_MODE_FALLBACK_STATUSES.has(status)) return false;
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function retryDelayMs(retryCount: number): number {
  return LLM_RETRY_BASE_DELAY_MS * (2 ** Math.min(retryCount, 4));
}

function waitForRetry(retryCount: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, retryDelayMs(retryCount)));
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

export class OpenAICompatibleLanguageModel implements LanguageModel {
  readonly isConfigured = true;
  readonly modelName: string;
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(options: OpenAICompatibleLanguageModelOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    this.modelName = options.model.trim();
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxTokens = options.maxTokens ?? 128;
    this.temperature = options.temperature ?? 0;
  }

  async complete(input: {
    readonly system: string;
    readonly prompt: string;
    readonly imageDataUrl?: string;
  }): Promise<string> {
    let response = await this.requestCompletionWithRetry(input, true);
    if (!response.ok && JSON_MODE_FALLBACK_STATUSES.has(response.status)) {
      response = await this.requestCompletionWithRetry(input, false);
    }

    if (!response.ok) throw new Error(`language model returned HTTP ${response.status}`);
    const payload = await response.json() as OpenAIChatResponse;
    const text = contentText(payload.choices?.[0]?.message?.content);
    if (!text) throw new Error('language model response has no content');
    return text;
  }

  private async requestCompletionWithRetry(
    input: {
      readonly system: string;
      readonly prompt: string;
      readonly imageDataUrl?: string;
    },
    includeJsonMode: boolean,
  ): Promise<Response> {
    let retryCount = 0;
    while (true) {
      try {
        const response = await this.requestCompletion(input, includeJsonMode);
        if (!isRetryableStatus(response.status) || retryCount >= LLM_MAX_RETRIES) return response;
      } catch (error) {
        if (retryCount >= LLM_MAX_RETRIES) throw error;
      }
      await waitForRetry(retryCount);
      retryCount += 1;
    }
  }

  private requestCompletion(
    input: {
      readonly system: string;
      readonly prompt: string;
      readonly imageDataUrl?: string;
    },
    includeJsonMode: boolean,
  ): Promise<Response> {
    const imageDataUrl = input.imageDataUrl?.trim();
    return fetch(this.endpoint, {
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
            content: imageDataUrl
              ? [
                { type: 'text', text: input.prompt },
                { type: 'image_url', image_url: { url: imageDataUrl } },
              ]
              : input.prompt,
          },
        ],
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        ...(includeJsonMode ? { response_format: { type: 'json_object' } } : {}),
        stream: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

export class UnavailableLanguageModel implements LanguageModel {
  readonly isConfigured = false;
  readonly modelName = 'unconfigured';

  async complete(_input: {
    readonly system: string;
    readonly prompt: string;
    readonly imageDataUrl?: string;
  }): Promise<string> {
    throw new Error('LLM answer service is not configured');
  }
}
