# AIC 2026 Retrieval Backend

The backend is a NestJS API for retrieval and operator review. It accepts
queries, runs configured feature branches, fuses results with RRF, stores
candidates/selections in PostgreSQL, and serves media previews through R2 or
FFmpeg. The service does not submit results to the competition system.

## Components

- PostgreSQL full-text search for captions, ASR, and OCR; `pg_trgm` for object
  labels;
- pgvector/HNSW for 1024-dimensional visual embeddings;
- query embeddings, LLM, and VLM through HTTP adapters, so PyTorch/VLM/LLM
  packages are not loaded into the NestJS process;
- branch isolation: a branch with a missing index or model is returned as
  unavailable without breaking the entire search;
- R2 presigned URLs for videos/keyframes and exact source-frame decoding with
  FFmpeg;
- retrieval runs/candidate snapshots, manual selection revisions, and
  JSON/CSV submission previews;
- operator-token authentication, CORS, request validation, and throttling.

Model ports are defined in `src/compute/model-ports.ts`. The VLM client and
visual reranking code are in `src/compute/vlm-vision.client.ts` and
`src/retrieval/`.

## Run locally

Node.js `>=20`, PostgreSQL with the `vector`/`pg_trgm` extensions, and FFmpeg
in `PATH` are required. You can set `FFMPEG_PATH` when FFmpeg is not on the
path. The quickest setup uses PostgreSQL and the embedding service from the
root Compose file:

```powershell
Copy-Item .env.example .env
# Fill in DATABASE_URL/DATABASE_DIRECT_URL and any optional services in .env.
Set-Location ../..
docker compose up -d --build postgres embedding
Set-Location apps/backend
npm install
npm run db:migrate
npm run db:verify
npm run start:dev
```

When the backend runs directly on the host, the local database normally uses
port `5433` and the embedding service uses
`http://127.0.0.1:8001/embed`. When running inside Compose, the root
`docker-compose.yml` replaces those addresses with service names.

The migration creates extensions and tables for videos, frames, evidence,
feature artifacts, index releases, retrieval runs, and manual selections. Build
indexes only after all data has been imported:

```powershell
npm run db:build-indexes
npm run db:verify
```

## Ingest refined artifacts

Feature extraction belongs under `pipelines/` and does not run inside the
backend runtime. The importer validates all input before opening a transaction
and writes the following relationship:

```text
video -> canonical frame -> frame alias -> evidence -> retrieval index
```

Run the importer from the repository root:

```powershell
python -m pip install -r pipelines/ingestion/requirements.txt
$env:PYTHONPATH = (Get-Location).Path
python -m pipelines.ingestion.import_refined `
  --data-root D:\data\refined `
  --dry-run
```

After the dry-run, remove `--dry-run` and provide `--database-url` or set
`DATABASE_DIRECT_URL`/`DATABASE_URL`. You can restrict the import with
`--video-id` or `--limit-videos`. The import is idempotent and does not require
uploading `.npy` matrices to R2; local vectors are written directly to
`clip_embeddings`.

## Media and exact frames

Frame routes use zero-based `original_frame_id` values.
`GET /v1/videos/:id/frames` returns a window around `center_frame_id`;
`limit` accepts values from `1` to `100`. The optional `frame_step` accepts
values from `1` to `100,000` and selects keyframes near source-frame positions
spaced by that many frames; the default is `1`. The Workbench uses the center
frame for CSV export.

If an exact-frame thumbnail does not exist, the backend seeks to a codec
keyframe and invokes FFmpeg to decode the exact source frame. When available,
`frame_count` is used to reject IDs beyond the video. All returned images have
size limits and may be compressed before being sent to VLM/VQA.

R2 uses an S3-compatible API. Object keys are organized by default as follows:

```text
datasets/<dataset-version>/videos/<video-id>.mp4
datasets/<dataset-version>/keyframes/<video-id>/<original-frame-id>.webp
features/<dataset-version>/<modality>/<model-version>/<artifact>
```

The browser sends only `video_id` and `original_frame_id`; the backend controls
signed URLs. If the database or R2 is not configured, the service enters
degraded mode and the health response identifies the unavailable dependency.

## LLM, VLM, and retrieval tuning

An OpenAI-compatible LLM is optional for VQA and query improvement. A VLM can
be enabled through backend configuration or overridden for a request from the
frontend; a request API key exists only in the tab's memory.

When VLM is enabled, you can use:

- `vlm` to answer VQA using an image;
- `retrieval.vlm_rerank` to rescore candidates using images;
- `VLM_MIN_SCORE` to filter candidates below a threshold;
- `VLM_QUERY_EXPANSION=true` to generate English query variants;
- `VLM_ADAPTIVE_TOP_K=true` to adjust the number of candidates sent to the VLM.

The current retrieval branches include caption, OCR lexical, ASR lexical,
object, and CLIP when the corresponding database/index/query encoder is ready.
Semantic, temporal, and audio branches require additional providers or indexes.

## API

Every route except `/health` requires the `x-operator-token` header when
`OPERATOR_TOKEN` is configured. For development, you can enable
`ALLOW_UNAUTHENTICATED_LOCAL=true`; do not use this option in staging or
production.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Database, object-storage, branch, and task status |
| `POST` | `/v1/search` | Multi-branch search and candidate snapshot persistence |
| `POST` | `/v1/search/exact-frames` | Search from known source-frame references |
| `POST` | `/v1/search/plan` | Inspect the static execution plan |
| `POST` | `/v1/query/improve` | Improve a query/question/event with an optional LLM |
| `POST` | `/v1/vqa/answer` | Generate a VQA answer suggestion from a frame |
| `GET` | `/v1/videos/:id/playback` | Video playback URI and metadata |
| `GET` | `/v1/videos/:id/studio` | Video-studio frames, evidence, and ASR |
| `GET` | `/v1/videos/:id/frames` | Frames near `center_frame_id` |
| `GET` | `/v1/videos/:id/frames/:frameId` | Exact canonical-frame metadata |
| `GET` | `/v1/videos/:id/frames/:frameId/thumbnail` | Exact-frame thumbnail bytes |
| `GET` | `/v1/videos/:id/keyframes/:keyframeNo` | Look up a canonical frame by alias |
| `GET` | `/v1/queries/:id/candidates` | Read a paginated candidate snapshot |
| `GET` | `/v1/queries/:id/selection` | Read the latest selection revision |
| `PUT` | `/v1/queries/:id/selection` | Save a new manual-selection revision |
| `POST` | `/v1/submissions/preview` | Validate and create a JSON/CSV preview |

Example text search:

```json
{
  "query": "người phụ nữ đang cầm vật gì",
  "task": "vqa",
  "top_k": 20,
  "retrieval": {
    "branch_k": 200,
    "fusion_k": 500,
    "display_k": 100,
    "near_frame_window_ms": 1000
  }
}
```

`near_frame_window_ms` filters results that are too close together in the same
video after fusion; set it to `0` to disable the filter. A source-frame search
does not require a text query:

```json
{
  "query": "",
  "task": "textual_kis",
  "top_k": 20,
  "frame_query": { "video_id": "L25_V078", "original_frame_id": 385 }
}
```

## Environment variables

Create `.env` from [`.env.example`](.env.example). The main variables are:

| Group | Variables | Purpose |
|---|---|---|
| Runtime | `PORT`, `CORS_ORIGINS`, `NODE_ENV` | Port, allowed origins, and environment |
| Auth | `OPERATOR_TOKEN`, `ALLOW_UNAUTHENTICATED_LOCAL` | API protection and local-only escape hatch |
| Database | `DATABASE_URL`, `DATABASE_DIRECT_URL` | Pooled runtime URL and direct migration URL |
| R2 | `R2_ENDPOINT_URL`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_REGION` | Object storage and credentials |
| R2 | `R2_SIGNED_URL_TTL_SECONDS` | Presigned URL TTL |
| Embedding | `EMBEDDING_SERVICE_URL`, `EMBEDDING_SERVICE_TOKEN`, `EMBEDDING_DIMENSIONS` | Text/image query encoder; default 1024 dimensions |
| LLM | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | VQA/query-improvement provider |
| LLM | `LLM_TIMEOUT_MS`, `LLM_MAX_TOKENS`, `LLM_TEMPERATURE` | Request and decoding limits |
| VLM | `VLM_ENABLED`, `VLM_BASE_URL`, `VLM_API_KEY`, `VLM_MODEL` | Default vision provider |
| VLM | `VLM_TIMEOUT_MS`, `VLM_TOP_K`, `VLM_WEIGHT`, `VLM_CONCURRENCY` | Reranking/VQA runtime |
| Advanced VLM | `VLM_MIN_SCORE`, `VLM_QUERY_EXPANSION`, `VLM_QUERY_EXPANSION_MAX_VARIANTS`, `VLM_ADAPTIVE_TOP_K` | Filtering, query expansion, and adaptive reranking |
| Frame | `FFMPEG_PATH`, `FRAME_DECODE_TIMEOUT_MS` | Exact-frame decoding/image compression |
| Version | `DATASET_ID`, `DATASET_VERSION`, `PIPELINE_VERSION`, `ARTIFACT_VERSION` | Dataset and pipeline provenance |
| Version | `INDEX_VERSION`, `INDEX_CHECKSUM`, `VERSION_STATUS`, `SCHEMA_VERSION` | Release/index validation |
| Version | `MODEL_VERSIONS_JSON` | Map modality names to model versions |

R2 requires the endpoint, bucket, access key, and secret to be configured
together. LLM/VLM requires both a base URL and a model. An `active` release
must have an `INDEX_VERSION` and a valid SHA-256 checksum.

## Verification

```powershell
npm test
npm run test:coverage
npm run typecheck
npm run build
```

The current coverage gate requires at least `80%` for statements/lines/functions
and `70%` for branches. Integration tests use fake dependencies or PostgreSQL
test doubles to cover authentication, search, media, frame decoding, manual
selection, VQA, and preview generation.
