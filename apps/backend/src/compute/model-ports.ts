export interface QueryEmbeddingProvider {
  readonly isConfigured: boolean;
  readonly dimensions: number;
  embedText(query: string): Promise<readonly number[]>;
}

export interface VisionLanguageModel {
  answer(input: { readonly question: string; readonly imageUrls: readonly string[] }): Promise<{ answer: string; confidence?: number }>;
}

export interface LanguageModel {
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
