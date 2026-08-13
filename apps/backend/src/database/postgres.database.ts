import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type QueryResultRow } from 'pg';

import type { DatabaseClient, DatabaseQueryResult } from './database.client';

@Injectable()
export class PostgresDatabase implements DatabaseClient, OnModuleDestroy {
  readonly isConfigured: boolean;
  private readonly pool?: Pool;

  constructor(databaseUrl?: string) {
    this.isConfigured = Boolean(databaseUrl);
    this.pool = databaseUrl
      ? new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 })
      : undefined;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<DatabaseQueryResult<T>> {
    if (!this.pool) throw new Error('DATABASE_URL is not configured');
    return this.pool.query<T>(sql, [...parameters]);
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
