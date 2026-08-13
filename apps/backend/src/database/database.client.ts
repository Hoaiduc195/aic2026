import type { QueryResultRow } from 'pg';

export interface DatabaseQueryResult<T extends QueryResultRow> {
  readonly rows: T[];
  readonly rowCount: number | null;
}

export interface DatabaseClient {
  readonly isConfigured: boolean;
  query<T extends QueryResultRow = QueryResultRow>(sql: string, parameters?: readonly unknown[]): Promise<DatabaseQueryResult<T>>;
  health(): Promise<boolean>;
}
