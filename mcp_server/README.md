# AIC Evidence MCP Server

Read-only MCP service for AIC frame retrieval, evidence tracing and bounded agentic search. The service runs locally over `stdio` and reuses the existing backend APIs for database retrieval, frame decoding, VQA grounding and R2 signed media access.

## Setup

```powershell
cd mcp_server
npm install
Copy-Item .env.example .env
npm run build
```

Set `AIC_BACKEND_URL` and, when backend operator authentication is enabled, `AIC_OPERATOR_TOKEN`. To enable the CLIP/visual query branch from the MCP process, set `MCP_EMBEDDING_SERVICE_URL`, optionally `MCP_EMBEDDING_SERVICE_TOKEN`, and `MCP_EMBEDDING_TIMEOUT_MS`. The MCP forwards this configuration as the validated `embedding` request field to both `/v1/search` and `/v1/search/plan`. The encoder must use the same CLIPA checkpoint, projection and 1024-dimensional space as the indexed vectors. `EMBEDDING_SERVICE_URL` and `EMBEDDING_SERVICE_TOKEN` are accepted as compatibility aliases. The MCP process must never write protocol logs to stdout; diagnostics are sent to stderr.

## Tools

- `search_frames` — search indexed AIC frames and evidence.
- `plan_search` — inspect the deterministic retrieval plan, branches and constraints.
- `search_exact_frames` — validate and retrieve exact frame references.
- `get_frame` — load exact frame metadata, including non-keyframes.
- `get_frame_image` — fetch an exact image through the backend/R2 path.
- `get_frame_context_batch` — load up to 100 exact frame evidence records and optionally 20 images in one response.
- `get_video` — load video metadata and signed playback URI.
- `get_video_studio` — load indexed keyframes and studio annotations.
- `get_video_context` — combine playback, studio and nearby-frame context.
- `get_nearby_frames` — load frames around a source frame.
- `get_frame_evidence` — normalize OCR, captions, objects and ASR.
- `suggest_vqa_answer` — request a grounded VQA suggestion for one exact frame.
- `get_candidates` — read persisted retrieval candidates.
- `get_selection` — read the latest manual selection without changing it.
- `preview_submission` — validate task-specific answer rows and generate a CSV preview; it never submits or saves.
- `prepare_top100_focus_csv` — return up to 100 ranked Textual KIS rows with a configurable number of top rows concentrated in one temporal segment of the strongest video; it never submits or saves.
- `parse_submission_csv` — parse quoted, multiline CSV answers without writing or submitting.
- `rank_frames` — rank by visual reference or textual evidence.
- `compare_frames` — compare candidates through backend visual retrieval.
- `trace_answer` — orchestrate retrieval, exact frame loading and nearby evidence.
- `search_loop` — run a bounded loop for an agent-supplied improved query: inspect the plan, search, load exact evidence, expand nearby frames and optionally fetch images/VQA suggestions.
- `check_trake_sequence` — verify four exact frames against four events and chronological order using the loop's coverage logic.
- `get_search_session` — inspect in-memory loop progress and stop reason.
- `get_backend_health` — inspect branch/dependency degradation.

Use `search_loop` first for VQA, KIS and TRAKE verification. The default limits are five iterations, 30 backend tool calls and 60 seconds; hard caps are eight iterations, 50 calls and 120 seconds. The loop stops only when exact evidence and the configured confidence target support the answer, or reports `uncertain`, `insufficient` or `budget_exhausted`.

For every successful `textual_kis` frame retrieval, the MCP instructions require an
automatic top-100 CSV workflow. The agent builds a candidate pool, chooses the video
owned by the strongest deterministically ranked candidate, reads an explicit focus
count from the prompt (default 20), and calls `prepare_top100_focus_csv`. The tool
keeps the requested focus rows in one temporal segment, caps the total at 100, and
reports shortfalls instead of padding. After a successful validated preview, including
the normal `preview_only` warning, the host agent
saves the returned headerless UTF-8 CSV in the current working directory as
`submission/<query-id>.csv`, keeping the exact query filename required by the
organizer. The focus video, effective focus count and row count are reported in the
Vietnamese response; the focus count is not appended to the filename.

VQA and TRAKE are also exported automatically after successful evidence verification;
the agent does not wait for a separate CSV request. VQA uses only answered,
evidence-backed rows in the official `video_id,frame_id,answer` shape, with up to 100
rows and the same configurable focus ordering when multiple frames are ranked. It
calls `suggest_vqa_answer` as needed and then `preview_submission`, saving a
validated result as `submission/<query-id>.csv`. TRAKE first calls
`check_trake_sequence`, then `preview_submission` with the official single sequence
row (`video_id` plus one frame ID per requested event, chronological). TRAKE is not
forced into 100 rows because that would violate its submission format; its validated
file is saved to the same exact-name path, `submission/<query-id>.csv`.

All user-facing summaries, warnings and paths are concise Vietnamese. For every task,
the host agent always saves a non-empty CSV returned by a successful validated preview
under `./submission/` relative to the current working directory and reports the
resolved absolute path. A `preview_only` warning means external submission is disabled;
it does not prevent this local save. Invalid or unsupported results are never saved.

For TRAKE, pass four event descriptions when they are available. The loop uses those events for local four-event coverage/order assessment; `/v1/search` and `/v1/search/plan` receive the main query only, never four event strings. VQA output is a suggestion and must be checked against the returned evidence. Every supported conclusion should cite `videoId`, `originalFrameId` or `keyframeNo`, timestamp and evidence IDs.

Retrieval queries should be concise English visual descriptions. Before calling `search_frames`, `plan_search`, `search_loop` or `trace_answer`, improve the query yourself: translate Vietnamese visual descriptions, preserve proper names and literal OCR text, include visible objects/actions/relations and temporal order, and remove filler. There is no `improve_query` tool; the agent supplies the improved query directly. Keep the original language for the user's question, final answer and evidence explanation.

## Agent configuration

Build the service and register the absolute path to `dist/main.js` in the MCP client's server configuration. `mcp.config.example.json` contains a Windows example. For other clients, use the same command and environment variables:

```text
command: node
args: ["D:/workspace/aic/src/mcp_server/dist/main.js"]
```

The backend must be running before the agent invokes a tool. The MCP service has no write tools and does not modify query history, queue, answers or submissions. Search sessions are in-memory, expire after 30 minutes, are capped at 20, and retain no operator token, signed URL or image bytes. `preview_submission` and `prepare_top100_focus_csv` are deliberately preview-only; the host agent performs the local file save in the current working directory after a successful validated preview.

## Development

```powershell
npm test
npm run test:coverage
npm run typecheck
npm run build
```
