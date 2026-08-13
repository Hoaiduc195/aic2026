import { describe, expect, it, vi } from 'vitest';

import { createOperatorAuthMiddleware } from '../src/common/operator-auth.middleware';
import { UnavailableRetrievalBranch } from '../src/retrieval/branch';

describe('operator auth and degraded branches', () => {
  it('allows health/no-token and rejects a wrong operator token', () => {
    const next = vi.fn();
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    createOperatorAuthMiddleware()({ path: '/v1/search', header: vi.fn() } as never, response as never, next);
    expect(next).toHaveBeenCalledOnce();

    next.mockClear();
    createOperatorAuthMiddleware('right')({ path: '/v1/search', header: vi.fn(() => 'wrong') } as never, response as never, next);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('reports an unavailable branch without throwing', async () => {
    const result = await new UnavailableRetrievalBranch('clip', 'encoder missing').search('q', {
      query_id: 'q', original_query: 'q', latency_budget_ms: 10, index_version: 'v1',
    } as never);
    expect(result).toMatchObject({ status: 'unavailable', error: { message: 'encoder missing' } });
  });
});
