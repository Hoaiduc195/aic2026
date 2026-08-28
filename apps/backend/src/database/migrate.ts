import 'dotenv/config';

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';

const MIGRATION_LOCK = 2_026_081_501;

export function canonicalSql(value: string): string {
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function checksum(value: string): string {
  return createHash('sha256').update(canonicalSql(value), 'utf8').digest('hex');
}

async function baselineSchemaIsCompatible(client: Client): Promise<boolean> {
  const result = await client.query<{ compatible: boolean }>(`
    WITH required_tables(name) AS (VALUES
      ('videos'), ('feature_sets'), ('index_releases'), ('index_release_features'),
      ('feature_artifacts'), ('frames'), ('evidence'), ('text_evidence'),
      ('object_evidence'), ('clip_embeddings'), ('ingestion_runs'),
      ('retrieval_runs'), ('retrieval_candidates'), ('manual_selections')
    ), required_columns(table_name, column_name) AS (VALUES
      ('videos', 'frame_count'), ('videos', 'object_key'),
      ('frames', 'original_frame_id'), ('frames', 'timestamp_ms'),
      ('evidence', 'feature_set_id'), ('evidence', 'original_frame_id'),
      ('clip_embeddings', 'embedding'), ('retrieval_candidates', 'fusion_trace')
    )
    SELECT
      NOT EXISTS (
        SELECT 1 FROM required_tables
        WHERE to_regclass('public.' || name) IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM required_columns required
        WHERE NOT EXISTS (
          SELECT 1 FROM information_schema.columns actual
          WHERE actual.table_schema = 'public'
            AND actual.table_name = required.table_name
            AND actual.column_name = required.column_name
        )
      )
      AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
      AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')
      AND EXISTS (
        SELECT 1
        FROM pg_attribute attribute
        JOIN pg_class relation ON relation.oid = attribute.attrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'clip_embeddings'
          AND attribute.attname = 'embedding'
          AND format_type(attribute.atttypid, attribute.atttypmod) = 'vector(1024)'
      ) AS compatible`);
  return result.rows[0]?.compatible === true;
}

async function migrate(): Promise<void> {
  const connectionString = process.env.DATABASE_DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_DIRECT_URL or DATABASE_URL is required');

  const migrationDirectory = resolve(process.cwd(), 'sql');
  const migrationFiles = (await readdir(migrationDirectory))
    .filter((name) => /^\d+[_-].+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (migrationFiles.length === 0) throw new Error('no SQL migration files were found');

  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    for (const version of migrationFiles) {
      const sql = canonicalSql(await readFile(resolve(migrationDirectory, version), 'utf8'));
      const digest = checksum(sql);
      const existing = await client.query<{ checksum_sha256: string }>(
        'SELECT checksum_sha256 FROM schema_migrations WHERE version = $1',
        [version],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum_sha256 !== digest) {
          if (version === '001_initial.sql' && await baselineSchemaIsCompatible(client)) {
            await client.query(
              'UPDATE schema_migrations SET checksum_sha256 = $2 WHERE version = $1',
              [version, digest],
            );
            process.stdout.write(
              `Reconciled ${version} checksum after verifying the existing baseline schema\n`,
            );
            continue;
          }
          throw new Error(
            `migration checksum mismatch for ${version}; schema compatibility repair was not safe`,
          );
        }
        process.stdout.write(`Skipped ${version} (already applied)\n`);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum_sha256) VALUES ($1, $2)',
          [version, digest],
        );
        await client.query('COMMIT');
        process.stdout.write(`Applied ${version}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    await client.end();
  }
}

migrate()
  .then(() => process.stdout.write('Database migrations are up to date\n'))
  .catch((error: unknown) => {
    process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
