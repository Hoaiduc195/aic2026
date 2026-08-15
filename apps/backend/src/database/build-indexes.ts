import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';

const INDEX_BUILD_LOCK = 2_026_081_502;
const EXPECTED_INDEXES = [
  'text_evidence_search_idx',
  'text_evidence_trgm_idx',
  'object_evidence_label_idx',
  'clip_embeddings_hnsw_idx',
] as const;

function statements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement && !statement.split(/\r?\n/).every((line) => /^\s*--/.test(line)));
}

async function buildIndexes(): Promise<void> {
  const connectionString = process.env.DATABASE_DIRECT_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_DIRECT_URL is required to build indexes');
  const sql = await readFile(resolve(process.cwd(), 'sql', 'post_import_indexes.sql'), 'utf8');
  const commands = statements(sql);
  if (commands.length === 0) throw new Error('post-import index SQL contains no statements');

  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [INDEX_BUILD_LOCK]);
    const existing = await client.query<{ index_name: string; is_valid: boolean }>(`
      SELECT c.relname AS index_name, i.indisvalid AS is_valid
      FROM pg_index AS i
      JOIN pg_class AS c ON c.oid = i.indexrelid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`, [EXPECTED_INDEXES]);
    for (const index of existing.rows.filter((row) => !row.is_valid)) {
      if (!EXPECTED_INDEXES.includes(index.index_name as typeof EXPECTED_INDEXES[number])) continue;
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.index_name}`);
    }
    for (const command of commands) await client.query(command);
    const verified = await client.query<{ index_name: string }>(`
      SELECT c.relname AS index_name
      FROM pg_index AS i
      JOIN pg_class AS c ON c.oid = i.indexrelid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND i.indisvalid
        AND c.relname = ANY($1::text[])`, [EXPECTED_INDEXES]);
    const validNames = new Set(verified.rows.map((row) => row.index_name));
    const missing = EXPECTED_INDEXES.filter((name) => !validNames.has(name));
    if (missing.length) throw new Error(`indexes are missing or invalid: ${missing.join(', ')}`);
    process.stdout.write(`Post-import search indexes are ready (${commands.length} statements)\n`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [INDEX_BUILD_LOCK]).catch(() => undefined);
    await client.end();
  }
}

buildIndexes().catch((error: unknown) => {
  process.stderr.write(`Index build failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
