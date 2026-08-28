# AIC Evidence MCP Server — TDD Evidence

## User journeys

- As an agent, I want to search the AIC retrieval database so that I can find relevant frames and evidence.
- As an agent, I want to fetch an exact ordinary frame or keyframe image so that manually selected non-keyframes remain traceable.
- As an agent, I want to compare and rank frames so that I can choose evidence using the existing backend retrieval logic.
- As an agent, I want one `trace_answer` tool so that retrieval, exact evidence and nearby frames are returned as one auditable report.
- As an agent, I want a bounded search loop so that query improvement, planning, retrieval, exact evidence and controlled expansion happen continuously without an unbounded tool loop.
- As an agent, I want TRAKE event coverage checked separately from retrieval so that the backend receives only the main query while four events remain auditable.
- As an operator, I want candidate, selection, VQA, studio and submission-preview APIs exposed read-only so that the agent can inspect the same evidence workflow without mutating state.
- As an agent, I want bounded batch/context tools and a safe CSV parser so that I can inspect more evidence per turn without losing quoted or multiline answers.
- As an agent, I want every Textual KIS retrieval to prepare up to 100 CSV rows with a configurable number of leading frames concentrated in one temporal segment, so that the focused evidence is easy to inspect without losing the wider ranking.
- As an agent, I want every successful VQA and TRAKE retrieval to automatically validate and save its task-specific CSV, so that submission output does not depend on a second user request.

## Validation

| Guarantee | Test | Type | Result |
|---|---|---|---|
| Invalid frame references and unsafe backend URLs are rejected | `tests/validation.test.ts` | unit | PASS |
| Backend search, exact-frame, keyframe, nearby, video and image calls use the existing API contract | `tests/backend-client.test.ts` | integration-style unit | PASS |
| Backend response payloads are validated before entering MCP results | `tests/backend-response.test.ts` | unit | PASS |
| Frame ranking is deterministic and deduplicates source frames | `tests/ranking.test.ts` | unit | PASS |
| Trace orchestration returns evidence or abstains when evidence is missing | `tests/trace-service.test.ts` | unit | PASS |
| MCP stdio exposes tools and serves an exact frame call | `tests/protocol.test.ts` | protocol/E2E | PASS |
| Bounded loop reaches supported VQA, expands on `needs_more_evidence`, checks four chronological TRAKE events and stops at tool budget | `tests/search-loop.test.ts` | unit | PASS |
| Session state is capped/expired and strips signed preview URLs | `tests/session-store.test.ts` | unit | PASS |
| Planning, query improvement, VQA, candidates, selection, preview and health payloads are validated | `tests/backend-response.test.ts` | unit | PASS |
| New read-only backend endpoints use the expected paths and snake_case request contracts | `tests/backend-client.test.ts` | integration-style unit | PASS |
| Batch frame context, video context and shared TRAKE sequence checking work without writes | `tests/context-service.test.ts` | unit | PASS |
| CSV parser preserves quoted commas/multiline answers and rejects invalid rows | `tests/csv-parser.test.ts` | unit | PASS |
| Top-N focus frames stay in one temporal segment, total rows are capped at 100, and duplicate source frames are removed | `tests/top-video.test.ts` | unit | PASS |
| MCP exposes `prepare_top100_focus_csv` and returns a 100-row preview with the configured focus count | `tests/protocol.test.ts` | protocol/E2E | PASS |
| MCP instructions require automatic export for Textual KIS, VQA and TRAKE, concise Vietnamese responses, current-working-directory saves and prompt-provided focus counts | `tests/server-instructions.test.ts` | unit | PASS |

Commands run:

```text
npm test                    # 53 tests passed
npm run test:coverage       # 93.22% statements, 73.77% branches, 99.15% functions
npm run typecheck           # passed
npm run build               # passed
```

## Scope and known gaps

- `tools.ts` registration glue is covered by the child-process MCP protocol test and excluded from the in-process V8 coverage aggregate.
- The MCP service is read-only and uses backend HTTP APIs; no direct database or R2 credentials are implemented in this service.
- `search_loop` is bounded by configurable defaults (`5` iterations, `30` calls, `60s`) and hard caps (`8`, `50`, `120s`). It reports evidence/confidence stop states instead of claiming unsupported answers.
- For TRAKE, events are sent to query improvement and local coverage assessment only. Search and plan requests contain the main query and no four-event payload.
- Session state is in-memory, capped at 20 entries with a 30-minute TTL, and removes signed preview URLs and image bytes.
- Visual comparison delegates ranking to the backend's existing frame-query/retrieval path; it does not introduce a second image model.
- `prepare_top100_focus_csv` is preview-only: the host agent saves the returned CSV after a submittable preview, while the MCP service remains read-only.
- Automatic VQA and TRAKE export is also preview-only: the host agent saves validated CSV text returned by `preview_submission` under `./submission/<query-id>.csv` in the current working directory, while the MCP service remains read-only.
