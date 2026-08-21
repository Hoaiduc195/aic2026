import { HttpQueryEmbeddingProvider, type QueryEmbeddingProvider } from '../compute/model-ports';
import type { DatabaseClient } from '../database/database.client';
import type { SearchRequest } from '../common/types';
import { PostgresClipBranch } from '../retrieval/postgres-clip.branch';
import type { RetrievalBranch } from '../retrieval/branch';

/**
 * Resolves the query encoder before retrieval starts.
 *
 * A request override creates a fresh CLIP branch with a fresh provider. The
 * RetrievalBranch contract stays unchanged: branches receive only query,
 * plan and abort signal, never provider configuration or request context.
 */
export class EmbeddingService {
  private readonly dimensions: number;

  constructor(
    private readonly database: DatabaseClient,
    private readonly defaultProvider: QueryEmbeddingProvider,
  ) {
    this.dimensions = defaultProvider.dimensions;
  }

  async findIndexedFrameEmbedding(
    videoId: string,
    originalFrameId: number,
    indexVersion: string,
  ): Promise<readonly number[] | null> {
    if (!this.database.isConfigured) return null;
    const result = await this.database.query<{ embedding: unknown }>(`
      SELECT c.embedding::text AS embedding
      FROM clip_embeddings c
      JOIN evidence e ON e.evidence_id = c.evidence_id
      JOIN feature_sets fs ON fs.feature_set_id = e.feature_set_id
      JOIN index_release_features irf
        ON irf.feature_set_id = fs.feature_set_id
       AND irf.dataset_version = fs.dataset_version
       AND irf.modality = fs.modality
      JOIN index_releases ir
        ON ir.index_version = irf.index_version
       AND ir.dataset_version = irf.dataset_version
      WHERE e.video_id = $1
        AND e.original_frame_id = $2
        AND ir.status = 'active'
        AND ir.index_version = $3
        AND fs.modality = 'visual_embedding'
        AND fs.embedding_dimensions = $4
      ORDER BY e.evidence_id
      LIMIT 1`, [videoId, originalFrameId, indexVersion, this.dimensions]);
    const raw = result.rows[0]?.embedding;
    return raw === undefined ? null : this.parseEmbedding(raw);
  }

  async embedImage(
    bytes: Uint8Array,
    mimeType: string,
    request?: SearchRequest,
  ): Promise<readonly number[]> {
    const provider = this.providerFor(request);
    if (!provider.isConfigured || !provider.embedImage) throw new Error('image embedding service is not configured');
    const embedding = await provider.embedImage(bytes, mimeType);
    return this.validateEmbedding(embedding);
  }

  resolveBranches(
    baseBranches: readonly RetrievalBranch[],
    request: SearchRequest,
    queryEmbedding?: readonly number[],
  ): readonly RetrievalBranch[] {
    if ((!request.embedding && !queryEmbedding) || !this.database.isConfigured) return baseBranches;

    const provider = this.providerFor(request);
    return baseBranches.map((branch) => branch.name === 'clip'
      ? new PostgresClipBranch(this.database, provider, queryEmbedding)
      : branch);
  }

  private providerFor(request?: SearchRequest): QueryEmbeddingProvider {
    if (!request?.embedding) return this.defaultProvider;
    return new HttpQueryEmbeddingProvider(
      request.embedding.base_url,
      this.dimensions,
      request.embedding.api_key,
      request.embedding.timeout_ms,
    );
  }

  private parseEmbedding(value: unknown): readonly number[] {
    const values = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.trim().replace(/^\[/, '').replace(/\]$/, '').split(',').filter(Boolean).map((item) => Number(item.trim()))
        : [];
    return this.validateEmbedding(values);
  }

  private validateEmbedding(values: readonly number[]): readonly number[] {
    if (values.length !== this.dimensions || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`frame embedding must contain ${this.dimensions} finite numbers`);
    }
    return [...values];
  }
}
