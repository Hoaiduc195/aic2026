# OpenAI-compatible LLM VQA TDD report

## Scope

- Add a server-side OpenAI-compatible chat-completions adapter.
- Ground answer suggestions from the selected video frame and database evidence.
- Keep answer suggestions separate from deterministic retrieval and manual submission.
- Let the reviewer edit the suggestion before it is added to the answer queue.
- Let a reviewer configure the LLM endpoint and generation parameters from the frontend settings panel.
- Keep frontend API keys in the current tab's memory; never persist them to `localStorage`.

## RED

Added failing tests for:

- OpenAI-compatible request shape, bearer authentication, content blocks, and malformed responses.
- VQA request validation, database grounding, safe abstention, and malformed model output.
- Backend authentication and endpoint validation.
- Frontend API client, BFF token forwarding, and frame-level answer suggestion without auto-save.
- Frontend settings persistence, validation, custom LLM request forwarding, and unsafe endpoint rejection.

## GREEN

Implemented:

- `OpenAICompatibleLanguageModel` with timeout, bounded output settings, and no secret logging.
- `POST /v1/vqa/answer`, protected by the existing operator middleware, global throttling, and a 20-request/minute route limit.
- Parameterized grounding lookup using `query_id`, `video_id`, and `original_frame_id`.
- Same-language, evidence-only JSON prompting with safe abstention when evidence or output is insufficient.
- Frontend BFF route and a reviewer-controlled “Gợi ý answer bằng LLM” action.
- Frontend “Cài đặt” panel for enable/disable, endpoint, model, timeout, max tokens, temperature, and API key.
- Per-request LLM configuration when enabled; otherwise the backend `.env` configuration is used.
- Per-request LLM configuration is always accepted after request validation.
- The selected keyframe is signed once through object storage, downloaded by the
  backend, and sent to the OpenAI-compatible LLM as a `data:` image URL whenever
  the LLM path is used and storage is available.

## Verification

- Backend: 73 tests passed; coverage 88.01% statements and 76.63% branches.
- Frontend: 47 tests passed; coverage 87.89% statements and 77.72% branches.
- Backend typecheck and production build passed.
- Frontend typecheck and production build passed.

## Runtime configuration

Set these backend environment variables to enable the feature:

```text
LLM_BASE_URL=https://provider.example/v1
LLM_API_KEY=...
LLM_MODEL=...
LLM_TIMEOUT_MS=15000
LLM_MAX_TOKENS=128
LLM_TEMPERATURE=0
```

`LLM_BASE_URL` and `LLM_MODEL` must be configured together. If they are absent, the endpoint remains available but returns a configuration error rather than inventing an answer.

The frontend settings are stored under `aic.llm.settings` in `localStorage`, except for `LLM_API_KEY`. The key is retained only in React memory for the current browser tab and is sent only when the reviewer enables the custom configuration. The BFF and backend validate endpoint and generation limits before forwarding the request.

## Streaming gateway regression fix (2026-08-18)

### RED

- Added a regression assertion that OpenAI-compatible requests must disable streaming and request a JSON object.
- Added a VQA prompt contract assertion requiring every response field.
- `pnpm --dir apps/backend test -- tests/model-ports.test.ts tests/vqa-answer.test.ts` failed with 2 expected failures before the production change.

### GREEN

- The adapter now sends `stream: false` and `response_format: { type: 'json_object' }`.
- The VQA system prompt explicitly requires `answer_status`, `answer`, `normalized_answer`, and `confidence`.

### Verification

- Targeted regression tests: 12/12 passed.
- Full backend suite: 79/79 tests passed across 24 files.
- Backend typecheck and production build passed.
- Backend coverage: 88.53% statements, 88.53% lines, 95.93% functions, 77.18% branches.
- Local browser flow with frontend LLM settings returned HTTP 201 and `answer_status: "answered"` with a generated answer in the selected-frame answer field.

## MoreVQA multimodal pipeline (2026-08-18)

### RED

- Added failing tests for the OpenAI-compatible VLM payload containing text plus
  `image_url`.
- Added tests requiring the VQA grounding query to return
  `thumbnail_object_key`, and requiring the service to sign that key before
  calling the VLM.
- Added tests for VLM-first answering, fallback to text LLM, bounded top-k VLM
  reranking, `vlm_rerank` trace fields, and frontend VLM settings that never
  persist the API key.

### GREEN

- Added `OpenAICompatibleVisionClient` and an unavailable no-op implementation.
- Restored MoreVQA in `VqaAnswerService`: signed R2 thumbnail → multimodal VLM
  answer → safe text-LLM fallback.
- Added optional `VlmRerankerService`, controlled by `VLM_*` environment values
  or the frontend retrieval sidebar, with per-candidate failure isolation.
- Added VLM configuration to the frontend settings modal and forwards it through
  the BFF; the VLM API key is memory-only like the text LLM key.
- Extended the search response schema for `vlm_rerank` traces and the existing
  `frames.thumbnail_object_key` schema was reused, so no database migration is
  required.

### Verification

- Backend: 87 tests passed across 25 files; coverage 87.63% statements/lines,
  95.76% functions, 77.79% branches.
- Frontend: 83 tests passed across 19 files.
- Backend/frontend typecheck and production builds passed; frontend lint passed.

## Keyframe image propagation to the text LLM (2026-08-18)

### RED

- Added a model-adapter test requiring `imageUrl` to become an OpenAI
  `image_url` content block.
- Added a VQA service test requiring the selected frame's
  `thumbnail_object_key` to be signed and forwarded to a configured text LLM.
- The targeted backend run failed with exactly these two missing-image
  assertions before production code was changed.

### GREEN

- Extended the `LanguageModel.complete` contract with an optional internal
  `imageUrl`.
- `VqaAnswerService` signs the selected thumbnail once and reuses the signed
  URL for the VLM and text-LLM paths.
- `OpenAICompatibleLanguageModel` now sends the prompt and image together as
  the user's multimodal content when a signed URL is present.
- The signed URL is derived only from the database grounding key and the
  server-side object-storage signer; it is never accepted as a client field or
  written to logs.

### Verification

- RED checkpoint: `pnpm --dir apps/backend test -- tests/model-ports.test.ts tests/vqa-answer.test.ts` — 2 intended failures.
- GREEN checkpoint: the same targeted command — 16/16 tests passed.
- Full backend suite: 89/89 tests passed across 25 files.
- Backend coverage: 87.66% statements/lines, 95.76% functions, 77.95% branches.
- Backend typecheck and production build passed.

If object storage is not configured or signing fails, no image URL can be
created; the existing text-only compatibility fallback remains available for
that degraded setup. With R2/object storage configured, every actual
OpenAI-compatible VQA LLM request receives the selected keyframe image.

## Backend-inline image payload (2026-08-18)

### RED

- Added tests requiring the backend to download the signed keyframe, enforce
  image response limits/types, and produce a `data:image/...;base64,...` URL.
- Updated LLM and VLM VQA tests to reject forwarding the R2 URL directly.
- The targeted run failed because the loader was missing and the model paths
  still forwarded the signed URL.

### GREEN

- Added `fetchImageAsDataUrl` with HTTP(S)-only validation, redirect blocking,
  a 5 MB response limit, supported image MIME/magic-byte checks, timeout, and
  base64 conversion.
- `VqaAnswerService` now downloads the signed thumbnail once and reuses the
  resulting data URL for both VLM and text LLM requests.
- The LLM contract now names the internal payload `imageDataUrl`, making it
  explicit that the provider does not need to fetch R2.

### Verification

- RED: `pnpm --dir apps/backend test -- tests/image-data-url.test.ts tests/model-ports.test.ts tests/vqa-answer.test.ts` — intended failures.
- GREEN: the same targeted command — 19/19 tests passed.
- Full backend suite: 92/92 tests passed across 26 files.
- Backend coverage: 87.53% statements/lines, 95.85% functions, 77.18% branches.
- Backend typecheck and production build passed.

If the backend cannot download the signed object, the system keeps the existing
degraded text-only fallback. In the normal R2-configured path, the LLM receives
the image bytes inline and no longer needs outbound access to R2.
