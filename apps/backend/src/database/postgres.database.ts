import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type QueryResultRow } from 'pg';

import type { DatabaseClient, DatabaseQueryOptions, DatabaseQueryResult } from './database.client';

function abortedQueryError(): Error {
  const error = new Error('database query aborted');
  error.name = 'AbortError';
  return error;
}

function assertStatementTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('statementTimeoutMs must be a positive integer');
}

@Injectable()
export class PostgresDatabase implements DatabaseClient, OnModuleDestroy {
  readonly isConfigured: boolean;
  private readonly pool?: Pool;

  constructor(databaseUrl?: string, pool?: Pool) {
    this.isConfigured = Boolean(databaseUrl);
    this.pool = pool ?? (databaseUrl
      ? new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 })
      : undefined);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    parameters: readonly unknown[] = [],
    options: DatabaseQueryOptions = {},
  ): Promise<DatabaseQueryResult<T>> {
    if (!this.pool) throw new Error('DATABASE_URL is not configured');
    if (options.statementTimeoutMs === undefined && !options.signal) {
      return this.pool.query<T>(sql, [...parameters]);
    }

    if (options.statementTimeoutMs !== undefined) assertStatementTimeout(options.statementTimeoutMs);
    return this.queryWithCancellation<T>(sql, parameters, options);
  }

  private async queryWithCancellation<T extends QueryResultRow>(
    sql: string,
    parameters: readonly unknown[],
    options: DatabaseQueryOptions,
  ): Promise<DatabaseQueryResult<T>> {
    const client = await this.pool!.connect();
    let released = false;
    let abortHandler: (() => void) | undefined;

    try {
      await client.query('BEGIN');
      if (options.statementTimeoutMs !== undefined) {
        await client.query("SELECT set_config('statement_timeout', $1, true)", [String(options.statementTimeoutMs)]);
      }
      if (options.signal?.aborted) throw abortedQueryError();

      const queryPromise = client.query<T>(sql, [...parameters]);
      const result = options.signal
        ? await new Promise<DatabaseQueryResult<T>>((resolve, reject) => {
            abortHandler = () => {
              released = true;
              client.release(true);
              reject(abortedQueryError());
            };
            options.signal!.addEventListener('abort', abortHandler, { once: true });
            queryPromise.then(resolve, reject);
          })
        : await queryPromise;

      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (!released) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      if (options.signal && abortHandler) options.signal.removeEventListener('abort', abortHandler);
      if (!released) client.release();
    }
  }

  async health(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
