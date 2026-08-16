import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/common/config';
import { createOperatorAuthMiddleware } from '../src/common/operator-auth.middleware';
import { UnavailableRetrievalBranch } from '../src/retrieval/branch';

describe('operator auth and degraded branches', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('allows explicit local bypass and rejects missing or wrong operator tokens otherwise', () => {
    const next = vi.fn();
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    createOperatorAuthMiddleware(undefined, true)({ path: '/v1/search', header: vi.fn() } as never, response as never, next);
    expect(next).toHaveBeenCalledOnce();

    next.mockClear();
    response.status.mockClear();
    createOperatorAuthMiddleware()({ path: '/v1/search', header: vi.fn() } as never, response as never, next);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();

    response.status.mockClear();
    createOperatorAuthMiddleware('right')({ path: '/v1/search', header: vi.fn(() => 'wrong') } as never, response as never, next);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('only enables unauthenticated bypass when explicitly configured for development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_UNAUTHENTICATED_LOCAL', 'true');
    vi.stubEnv('OPERATOR_TOKEN', '');
    expect(loadConfig().allowUnauthenticatedLocal).toBe(true);

    vi.stubEnv('NODE_ENV', 'staging');
    expect(() => loadConfig()).toThrow('OPERATOR_TOKEN is required outside local development');
  });

  it('reports an unavailable branch without throwing', async () => {
    const result = await new UnavailableRetrievalBranch('clip', 'encoder missing').search('q', {
      query_id: 'q', original_query: 'q', latency_budget_ms: 10, index_version: 'v1',
    } as never);
    expect(result).toMatchObject({ status: 'unavailable', error: { message: 'encoder missing' } });
  });
});
