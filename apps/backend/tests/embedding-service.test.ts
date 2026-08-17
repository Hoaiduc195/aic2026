import { describe, expect, it, vi } from 'vitest';

import { EmbeddingService } from '../src/embedding_services/embedding.service';
import type { QueryEmbeddingProvider } from '../src/compute/model-ports';
import type { DatabaseClient } from '../src/database/database.client';
import { PostgresClipBranch } from '../src/retrieval/postgres-clip.branch';
import { UnavailableRetrievalBranch } from '../src/retrieval/branch';

describe('EmbeddingService', () => {
  it('replaces only the CLIP branch for a request without passing context through branch.search', () => {
    const database: DatabaseClient = {
      isConfigured: true,
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      health: vi.fn(async () => true),
    };
    const defaultProvider: QueryEmbeddingProvider = {
      isConfigured: false,
      dimensions: 1024,
      embedText: vi.fn(),
    };
    const service = new EmbeddingService(database, defaultProvider);
    const clipBranch = new UnavailableRetrievalBranch('clip');
    const captionBranch = new UnavailableRetrievalBranch('caption');
    const baseBranches = [clipBranch, captionBranch] as const;

    const resolved = service.resolveBranches(baseBranches, {
      query: 'a red car',
      task: 'textual_kis',
      embedding: {
        base_url: 'http://127.0.0.1:8001/embed',
        api_key: 'session-secret',
        timeout_ms: 2500,
      },
    });

    expect(resolved).not.toBe(baseBranches);
    expect(resolved[0]).toBeInstanceOf(PostgresClipBranch);
    expect(resolved[1]).toBe(captionBranch);
    expect(clipBranch).toBe(baseBranches[0]);
  });
});
