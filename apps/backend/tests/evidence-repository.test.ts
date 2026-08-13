import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '../src/database/database.client';
import { EmptyEvidenceRepository, PostgresEvidenceRepository } from '../src/retrieval/evidence.repository';

describe('evidence repositories', () => {
  it('hydrates text/object snippets in one parameterized query', async () => {
    const database: DatabaseClient = {
      isConfigured: true,
      health: vi.fn(async () => true),
      query: vi.fn(async () => ({ rows: [{
        evidence_id: 'e-1', type: 'caption', start_ms: 10, end_ms: 20,
        snippet: 'a red bike', producer: 'captioner-v1',
      }] as never[], rowCount: 1 })),
    };
    const evidence = await new PostgresEvidenceRepository(database).findByIds(['e-1']);
    expect(evidence.get('e-1')).toMatchObject({ snippet: 'a red bike', start_ms: 10 });
    expect(vi.mocked(database.query).mock.calls[0][1]).toEqual([['e-1']]);
  });

  it('avoids a database call for empty evidence and supports offline mode', async () => {
    const database = { isConfigured: true, health: vi.fn(), query: vi.fn() } as unknown as DatabaseClient;
    await expect(new PostgresEvidenceRepository(database).findByIds([])).resolves.toEqual(new Map());
    expect(database.query).not.toHaveBeenCalled();
    await expect(new EmptyEvidenceRepository().findByIds(['e'])).resolves.toEqual(new Map());
  });
});
