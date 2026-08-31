# AIC 2026 Frontend Workbench

This Next.js/React/TypeScript application lets operators review retrieval
results and create submission previews. The UI follows a `frame-first` model:
every result has a clearly identified source frame, while video, nearby frames,
and metadata are loaded lazily when the operator needs to verify the result.

## User flow

1. Choose a task and enter a query in the sidebar.
2. Select `Search frames` to retrieve candidates from
   `/api/v1/search`.
3. Select a frame to inspect its evidence, canonical frame, or video studio.
4. For VQA/TRAKE, add frames to the queue and edit answers manually.
5. Save the selection and create a JSON/CSV submission preview in the
   `Answers` drawer.

The frontend supports the qualification tasks `textual_kis`, `vqa`, and
`trake`. The search API also accepts other retrieval tasks defined by the
backend contract.

## Runtime architecture

```text
Browser
  -> Next.js route handlers (/api/v1/*)
  -> NestJS backend (server-to-server, when configured)
  -> PostgreSQL/pgvector, R2, and optional model services
```

The browser calls only `/api/v1/*` routes. `BACKEND_API_URL` and
`BACKEND_OPERATOR_TOKEN` are read only on the server; the BFF forwards the
token to the backend and never sends it to the browser.

When `BACKEND_API_URL` is empty, search uses deterministic fixtures for UI
development. Routes that require persistence or media from the backend return
`503` instead of creating fake data.

## Install and run locally

Node.js `>=20` is required. From this directory:

```powershell
corepack enable
pnpm install
pnpm dev
```

Open <http://localhost:3000>. To use the real backend, create `.env.local`
from the example file and fill in `BACKEND_API_URL` and the corresponding
token:

```powershell
Copy-Item .env.example .env.local
```

```env
BACKEND_API_URL=http://localhost:4000
BACKEND_OPERATOR_TOKEN=replace-with-backend-operator-token
NEXT_PUBLIC_API_BASE_URL=/api
```

The backend and database have separate instructions in
[../backend/README.md](../backend/README.md). Instructions for starting the
full stack are in [../../README.md](../../README.md) and
[../../RUNBOOK_LOCAL_DOCKER.md](../../RUNBOOK_LOCAL_DOCKER.md).

## Nearby frames and CSV export

After a search result is available, the `Nearby frames` panel lets the operator:

- choose a center frame from the current result list;
- choose Top-K from `1` to `100`, defaulting to `4`; the count **includes the
  center frame**;
- choose `frame_step` from `1` to `100,000` source frames, defaulting to `1`,
  to control the spacing between selected frames;
- call
  `GET /api/v1/videos/:videoId/frames?center_frame_id=...&limit=...&frame_step=...`;
- view frames from the same video in timeline order and mark the center frame;
- after loading, insert new frames directly below the center frame in the
  `Frame results` list and deduplicate by
  `(video_id, original_frame_id)`; the list may exceed its initial display
  count;
- fill the answer queue with at most `100` frames in the current result-list
  order;
- export CSV after a successful load.

The CSV contains `video_id`, `original_frame_id`, `keyframe_no`,
`timestamp_ms`, and `is_center`. Exported data is limited to frames from the
center frame's video, deduplicated by `(video_id, original_frame_id)`, and
protects cells beginning with `=`, `+`, `-`, or `@` when opened in a
spreadsheet.

The backend may return sparse frames or decode an exact source frame with
FFmpeg when a thumbnail does not exist. The frontend never derives a frame ID
from a timestamp.

## Local media and R2

When the backend/R2 is configured, playback and thumbnails use server-issued
signed URLs. When the backend is not configured, lazy preview routes can use a
local media root through `AIC_MEDIA_ROOT`.

At minimum, local media should include:

```text
<AIC_MEDIA_ROOT>/
├── videos/
├── keyframes/
├── map-keyframes-aic25-b1/map-keyframes/
└── media-info-aic25-b1/media-info/
```

The Windows fallback in the code is `E:\aic2026`, but an explicit value is
recommended so local development, E2E tests, and other machines use the same
layout. `AIC_MEDIA_ACCESS_TOKEN` is server-only; do not enable
`AIC_ALLOW_UNAUTHENTICATED_MEDIA=true` on a machine reachable from an external
network.

## Environment variables

| Variable | Scope | Required | Purpose |
|---|---|---:|---|
| `BACKEND_API_URL` | Server | No | NestJS URL; leave empty to use fixture search |
| `BACKEND_OPERATOR_TOKEN` | Server | No for local | Token forwarded by the BFF to the backend |
| `NEXT_PUBLIC_API_BASE_URL` | Browser | No | Browser route base, default `/api` |
| `AIC_MEDIA_ROOT` | Server | No | Local media root for fallback |
| `AIC_MEDIA_ACCESS_TOKEN` | Server | No | Protects local media sessions |
| `AIC_ALLOW_UNAUTHENTICATED_MEDIA` | Server | No | Only for isolated local environments |

Do not put credentials, R2 keys, LLM/VLM keys, or backend tokens under the
`NEXT_PUBLIC_` prefix. Variables with that prefix may be included in the
browser bundle.

## Next.js API routes

| Group | Routes |
|---|---|
| Search | `/api/v1/search`, `/api/v1/search/exact-frames` |
| Query/VQA | `/api/v1/query/improve`, `/api/v1/vqa/answer` |
| Video/frame | `/api/v1/videos/:videoId/*`, `/api/v1/media/*` |
| Manual review | `/api/v1/queries/:queryId/candidates`, `/selection` |
| Submission | `/api/v1/submissions/preview` |

Contract responses are parsed and validated in `src/lib/api.ts` before they
reach the UI. When changing a payload, update `src/lib/contracts.ts` and the
corresponding route tests at the same time.

## Verification

```powershell
pnpm test
pnpm test:coverage
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm build
```

E2E tests in `tests/e2e/qualification.spec.ts` mock the API so the frame-first
flow remains deterministic. Integration with the real backend requires the
backend, database, embedding service, and R2 (when playback is needed) to be
configured separately.
