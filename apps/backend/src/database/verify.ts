import 'dotenv/config';

import { Client } from 'pg';

const EXPECTED_EXTENSIONS = ['pg_trgm', 'vector'] as const;
const EXPECTED_TABLES = [
  'clip_embeddings',
  'evidence',
  'feature_artifacts',
  'feature_sets',
  'frames',
  'index_release_features',
  'index_releases',
  'ingestion_runs',
  'manual_selections',
  'object_evidence',
  'retrieval_candidates',
  'retrieval_runs',
  'schema_migrations',
  'text_evidence',
  'videos',
] as const;

function missing(expected: readonly string[], actual: readonly string[]): string[] {
  const values = new Set(actual);
  return expected.filter((value) => !values.has(value));
}

async function verify(): Promise<void> {
  const connectionString = process.env.DATABASE_DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_DIRECT_URL or DATABASE_URL is required');

  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const extensionResult = await client.query<{ extname: string }>(`
      SELECT extname FROM pg_extension
      WHERE extname = ANY($1::text[])
      ORDER BY extname`, [EXPECTED_EXTENSIONS]);
    const tableResult = await client.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename = ANY($1::text[])
      ORDER BY tablename`, [EXPECTED_TABLES]);
    const typeResult = await client.query<{ embedding_type: string }>(`
      SELECT format_type(a.atttypid, a.atttypmod) AS embedding_type
      FROM pg_attribute AS a
      JOIN pg_class AS c ON c.oid = a.attrelid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'clip_embeddings'
        AND a.attname = 'embedding'
        AND NOT a.attisdropped`);

    const missingExtensions = missing(EXPECTED_EXTENSIONS, extensionResult.rows.map((row) => row.extname));
    const missingTables = missing(EXPECTED_TABLES, tableResult.rows.map((row) => row.tablename));
    const embeddingType = typeResult.rows[0]?.embedding_type;
    if (missingExtensions.length || missingTables.length || embeddingType !== 'vector(1024)') {
      throw new Error([
        missingExtensions.length ? `missing extensions: ${missingExtensions.join(', ')}` : '',
        missingTables.length ? `missing tables: ${missingTables.join(', ')}` : '',
        embeddingType !== 'vector(1024)' ? `embedding type is ${embeddingType ?? 'missing'}, expected vector(1024)` : '',
      ].filter(Boolean).join('; '));
    }

    process.stdout.write(
      `Database schema verified: ${EXPECTED_EXTENSIONS.length} extensions, ${EXPECTED_TABLES.length} tables, ${embeddingType}\n`,
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

verify().catch((error: unknown) => {
  process.stderr.write(`Database verification failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
