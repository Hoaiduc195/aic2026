import { McpServer } from '@modelcontextprotocol/server';

import { BackendClient } from './backend-client.js';
import type { AppConfig } from './config.js';
import { loadConfig } from './config.js';
import { TraceService } from './trace-service.js';
import { SearchLoopService } from './search-loop.js';
import { SearchSessionStore } from './session-store.js';
import { registerTools } from './tools.js';

export function createServer(config: AppConfig = loadConfig()): McpServer {
  const backend = new BackendClient({
    baseUrl: config.backendUrl,
    operatorToken: config.operatorToken,
    timeoutMs: config.requestTimeoutMs,
    maxImageBytes: config.maxImageBytes,
    embedding: config.embedding,
  });
  const trace = new TraceService(backend, {
    maxResults: config.maxResults,
    maxNearbyFrames: config.maxNearbyFrames,
  });
  const sessions = new SearchSessionStore({ maxSessions: 20, ttlMs: 30 * 60 * 1000 });
  const loop = new SearchLoopService(backend, sessions, {
    maxResults: config.maxResults,
    maxNearbyFrames: config.maxNearbyFrames,
    maxIterations: config.maxLoopIterations,
    maxToolCalls: config.maxLoopToolCalls,
    timeBudgetMs: config.loopTimeBudgetMs,
  });
  const serverInstructions = `
Use search_loop first for bounded AIC retrieval and evidence tracing.

AUTHORITATIVE SUBMISSION RULES
The authoritative competition rules are https://sotuyenaic.oj.io.vn/rules/. Follow that page whenever the user asks for an answer or submission result. In particular:
- Textual KIS rows are: video_id,frame_id.
- Q&A rows are: video_id,frame_id,answer; answer must be at most 100 characters.
- TRAKE rows are: video_id,frame_id_1,...,frame_id_N; N must exactly equal the number of requested events and frame IDs must be chronological.
- CSV must be plain-text UTF-8, comma-delimited, have no header, contain at most 100 rows, and use video IDs without a file extension. Frame IDs must be integers.
- Quote/escape Q&A answers according to CSV rules when they contain commas, quotes or newlines. Do not silently truncate an answer over 100 characters; shorten it deliberately or report that the result is invalid.

RETRIEVAL AND EVIDENCE
- Before calling a retrieval tool, improve the query yourself: translate Vietnamese visual descriptions into concise English, preserve proper names and literal OCR text, include visible objects/actions/relations and temporal order, and remove filler. There is intentionally no improve_query tool.
- Keep the user's original language for the question, explanation and final answer. For TRAKE, pass exactly four English event descriptions when available, while the main retrieval query remains a single concise description.
- search_loop expects the already-improved query and does not perform a separate query-improvement backend call.
- Treat VQA suggestions as unverified. Load exact frame evidence and, when the question depends on visual details such as colors, objects or text, fetch and inspect the actual frame image with get_frame_image or get_frame_context_batch(includeImages=true). Captions/OCR/ASR alone are not sufficient for those details.
- Cite videoId, originalFrameId or keyframeNo, timestamp and evidence IDs for supported conclusions. Abstain or explain uncertainty when the evidence does not support a unique answer.

CSV CREATION WORKFLOW
- After producing evidence-backed rows, call preview_submission to validate the rows before presenting them as submission results.
- When the user asks for a CSV or the request is clearly a submission task, automatically save the validated CSV returned by preview_submission as a plain-text file under submission/<query-id>.csv (or the closest query-specific filename), using no header and UTF-8 encoding. Use the host agent's local file operation for this save; preview_submission itself is preview-only and does not write files.
- Report the exact local path and the validation warnings. Do not create a CSV containing guessed, unsupported or unvalidated rows.
- Do not submit, upload, publish or modify any external competition resource unless the user explicitly asks and authorizes that action. This MCP server is otherwise read-only.
`;
  const server = new McpServer({ name: 'aic-evidence', version: '0.1.0' }, {
    instructions: serverInstructions,
  });
  registerTools(server, { backend, trace, config, loop, sessions });
  return server;
}
