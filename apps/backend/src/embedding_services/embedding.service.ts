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

  resolveBranches(
    baseBranches: readonly RetrievalBranch[],
    request: SearchRequest,
  ): readonly RetrievalBranch[] {
    if (!request.embedding || !this.database.isConfigured) return baseBranches;

    const provider = new HttpQueryEmbeddingProvider(
      request.embedding.base_url,
      this.dimensions,
      request.embedding.api_key,
      request.embedding.timeout_ms,
    );
    return baseBranches.map((branch) => branch.name === 'clip'
      ? new PostgresClipBranch(this.database, provider)
      : branch);
  }
}
