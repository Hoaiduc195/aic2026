import type { QueryResultRow } from 'pg';

export interface DatabaseQueryResult<T extends QueryResultRow> {
  readonly rows: T[];
  readonly rowCount: number | null;
}

export interface DatabaseQueryOptions {
  readonly signal?: AbortSignal;
  readonly statementTimeoutMs?: number;
}

export interface DatabaseClient {
  readonly isConfigured: boolean;
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    parameters?: readonly unknown[],
    options?: DatabaseQueryOptions,
  ): Promise<DatabaseQueryResult<T>>;
  health(): Promise<boolean>;
}
