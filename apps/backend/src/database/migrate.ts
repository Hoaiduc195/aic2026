import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';

async function migrate(): Promise<void> {
  const connectionString = process.env.DATABASE_DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_DIRECT_URL or DATABASE_URL is required');

  const sql = await readFile(resolve(process.cwd(), 'sql/001_initial.sql'), 'utf8');
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

migrate()
  .then(() => process.stdout.write('Applied sql/001_initial.sql\n'))
  .catch((error: unknown) => {
    process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
