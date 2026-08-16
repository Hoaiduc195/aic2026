import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { PostgresDatabase } from '../src/database/postgres.database';

function fakePool(client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }): Pool {
  return {
    connect: vi.fn(async () => client),
    query: vi.fn(),
    end: vi.fn(async () => undefined),
  } as unknown as Pool;
}

describe('PostgresDatabase query cancellation', () => {
  it('sets a local server-side statement timeout and commits the query', async () => {
    const client = {
      query: vi.fn(async (..._args: readonly unknown[]) => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    };
    const database = new PostgresDatabase('postgres://test', fakePool(client));

    await database.query('SELECT 1', [], { statementTimeoutMs: 250 });

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      "SELECT set_config('statement_timeout', $1, true)",
      'SELECT 1',
      'COMMIT',
    ]);
    expect(client.query.mock.calls[1][1]).toEqual(['250']);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('destroys the pooled connection when the abort signal fires', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const client = {
      query: vi.fn(async (sql: string, ..._args: readonly unknown[]) => {
        if (sql === 'SELECT slow') {
          markStarted();
          return new Promise<never>(() => undefined);
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const database = new PostgresDatabase('postgres://test', fakePool(client));
    const controller = new AbortController();
    const pending = database.query('SELECT slow', [], { signal: controller.signal, statementTimeoutMs: 1000 });

    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.release).toHaveBeenCalledWith(true);
  });
});
