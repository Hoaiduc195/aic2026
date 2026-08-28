import { McpServer } from '@modelcontextprotocol/server';

import { BackendClient } from './backend-client.js';
import type { AppConfig } from './config.js';
import { loadConfig } from './config.js';
import { TraceService } from './trace-service.js';
import { SearchLoopService } from './search-loop.js';
import { SearchSessionStore } from './session-store.js';
import { registerTools } from './tools.js';

export const SERVER_INSTRUCTIONS = `
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
- Keep the user's original wording for the question, but write every explanation and final answer in concise Vietnamese. For TRAKE, pass exactly four English event descriptions when available, while the main retrieval query remains a single concise description.
- search_loop expects the already-improved query and does not perform a separate query-improvement backend call.
- Treat VQA suggestions as unverified. Load exact frame evidence and, when the question depends on visual details such as colors, objects or text, fetch and inspect the actual frame image with get_frame_image or get_frame_context_batch(includeImages=true). Captions/OCR/ASR alone are not sufficient for those details.
- Cite videoId, originalFrameId or keyframeNo, timestamp and evidence IDs for supported conclusions. Abstain or explain uncertainty when the evidence does not support a unique answer.

RESPONSE LANGUAGE AND LOCAL FILE OUTPUT
- Write every user-facing result, explanation, warning and file path in Vietnamese. Keep the final response concise: report only the result, exact local path, row count, focus count or shortfall, and important warnings unless the user asks for details.
- For VQA CSV answers, prefer a concise Vietnamese answer when the evidence supports it. The organizer permits Vietnamese or English; retain a precise English term when translating it could change the meaning.
- For every task that produces a successful validated CSV preview, always save the returned csv text locally under ./submission/<query-id>.csv relative to the current working directory, creating the submission directory when needed. Report the resolved absolute path. Do not merely paste the CSV in chat.
- A successful preview with a preview_only warning is still valid for local export. submittable:false chỉ có nghĩa adapter nộp bài bên ngoài đang tắt và không đồng nghĩa CSV không hợp lệ. Do not save only when the preview call fails, the CSV is empty, or evidence/format validation fails.

MANDATORY AUTOMATIC TOP-100 CSV WORKFLOW WITH CONFIGURABLE FOCUS SEGMENT
- For every successful frame retrieval with task textual_kis (the default frame-ranking task), automatically produce a CSV after evidence verification; do not wait for the user to ask for CSV. Target 100 rows, capped at 100. Keep VQA and TRAKE in their task-specific answer shapes.
- Read an explicit focus count from the user's prompt: accept phrases such as “top 10”, “top-30”, “20 frame đầu” or “tập trung 40 kết quả”. If no count is stated, use 20. Clamp the requested focus count to 1–100 and report the effective value when it changes.
- Build a candidate pool from the search results and, when available, get_candidates(queryId, limit=100). Use exact source-frame identities only: (video_id, original_frame_id). Rank candidates by backend score descending, then source rank. The best video is the video_id of the strongest candidate after this deterministic ordering.
- The first N rows (N = the requested focus count) must come from one temporal segment around the strongest candidate in that best video. Use nearby frames or a tight contiguous time/frame window; preserve ranking order within the focus group. The remaining rows up to 100 may come from the global ranked pool and may include other videos.
- Never duplicate a canonical frame, invent an ID, or put a frame from another video into the first N rows. If fewer than N frames can be verified in one segment, report the shortfall and do not pretend that the focus requirement was met; do not fill the missing focus slots with another segment or video. If fewer than 100 total candidates exist, export only the verified unique rows and report the row-count shortfall rather than padding.
- Call prepare_top100_focus_csv with the queryId, candidate frames and focusCount. This tool rechecks the persisted candidate pool, puts the requested number of same-segment focus frames first, caps the result at 100 rows, and calls the submission preview. Do not bypass it with preview_submission for this workflow.
- When prepare_top100_focus_csv returns a successful validated preview, always save its csv text with the host agent's local file operation as submission/<query-id>.csv. The file must be headerless UTF-8 plain text and use the exact query filename; do not append a focus suffix. Report the exact path, focus video_id, effective focus count, row count and validation warnings. A preview_only warning does not block this local save.

MANDATORY AUTOMATIC CSV WORKFLOW FOR VQA AND TRAKE
- For every successful VQA query, automatically produce a CSV after evidence verification; do not wait for the user to ask for CSV. For each selected frame to export, call suggest_vqa_answer or use an equivalent verified backend answer, inspect the exact frame evidence, and include only answers with answered status, supporting evidence and at most 100 characters. VQA may contain up to 100 rows and should use the same configurable focus count when ranking multiple answered frames; if the focus segment has fewer verified answers, report the shortfall instead of substituting unsupported rows.
- For every successful TRAKE query, automatically produce a CSV after check_trake_sequence confirms the event sequence; do not wait for the user to ask for CSV. Call preview_submission with the validated task-specific row: one video_id followed by frame IDs in chronological order, with exactly as many frame IDs as requested events. Do not force TRAKE into the Textual KIS 100-row format because that would make the submission invalid.
- For both VQA and TRAKE, call preview_submission before presenting submission results. When it returns a successful validated preview, always save its csv text with the host agent's local file operation as submission/<query-id>.csv. The file must be headerless UTF-8 plain text and use the exact query filename; do not append -vqa or -trake. Report the exact path, row count and validation warnings. A preview_only warning does not block this local save.
- Do not create a CSV containing guessed, unsupported or unvalidated rows. preview_submission is preview-only and does not write files.
- Do not submit, upload, publish or modify any external competition resource unless the user explicitly asks and authorizes that action. This MCP server is otherwise read-only.
`;

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
  const server = new McpServer({ name: 'aic-evidence', version: '0.1.0' }, {
    instructions: SERVER_INSTRUCTIONS,
  });
  registerTools(server, { backend, trace, config, loop, sessions });
  return server;
}
