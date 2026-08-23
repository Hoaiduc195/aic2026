import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createServer } from './server.js';

loadDotenv({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

try {
  await serveStdio(() => createServer());
} catch (error) {
  console.error('AIC Evidence MCP server stopped:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
}
