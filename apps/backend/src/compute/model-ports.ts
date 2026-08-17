export interface QueryEmbeddingProvider {
  readonly isConfigured: boolean;
  readonly dimensions: number;
  embedText(query: string): Promise<readonly number[]>;
}

export interface VisionLanguageModel {
  answer(input: { readonly question: string; readonly imageUrls: readonly string[] }): Promise<{ answer: string; confidence?: number }>;
}

export interface LanguageModel {
  readonly isConfigured: boolean;
  readonly modelName: string;
  complete(input: { readonly system: string; readonly prompt: string }): Promise<string>;
}

export interface TemporalAligner {
  align(input: { readonly events: readonly string[]; readonly candidateIds: readonly string[] }): Promise<readonly string[]>;
}

export class HttpQueryEmbeddingProvider implements QueryEmbeddingProvider {
  readonly isConfigured = true;

  constructor(
    private readonly endpoint: string,
    public readonly dimensions: number,
    private readonly bearerToken?: string,
    private readonly timeoutMs = 5000,
  ) {}

  async embedText(query: string): Promise<readonly number[]> {
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
    if (!Array.isArray(payload.embedding) || payload.embedding.length !== this.dimensions
      || payload.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`embedding service must return ${this.dimensions} finite numbers`);
    }
    return payload.embedding as number[];
  }
}

export class UnavailableQueryEmbeddingProvider implements QueryEmbeddingProvider {
  readonly isConfigured = false;
  constructor(public readonly dimensions = 1024) {}
  async embedText(_query: string): Promise<readonly number[]> { throw new Error('query embedding service is not configured'); }
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

  async complete(input: { readonly system: string; readonly prompt: string }): Promise<string> {
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
          { role: 'user', content: input.prompt },
        ],
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`language model returned HTTP ${response.status}`);
    const payload = await response.json() as OpenAIChatResponse;
    const text = contentText(payload.choices?.[0]?.message?.content);
    if (!text) throw new Error('language model response has no content');
    return text;
  }
}

export class UnavailableLanguageModel implements LanguageModel {
  readonly isConfigured = false;
  readonly modelName = 'unconfigured';

  async complete(_input: { readonly system: string; readonly prompt: string }): Promise<string> {
    throw new Error('LLM answer service is not configured');
  }
}
