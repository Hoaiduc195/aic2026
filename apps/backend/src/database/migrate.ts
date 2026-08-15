import 'dotenv/config';

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';

const MIGRATION_LOCK = 2_026_081_501;

function checksum(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
      const sql = await readFile(resolve(migrationDirectory, version), 'utf8');
      const digest = checksum(sql);
      const existing = await client.query<{ checksum_sha256: string }>(
        'SELECT checksum_sha256 FROM schema_migrations WHERE version = $1',
        [version],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum_sha256 !== digest) {
          throw new Error(`migration checksum mismatch for ${version}; never edit an applied migration`);
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
