# AIC 2026 Retrieval Backend

Backend là NestJS API cho retrieval và operator review. Service nhận query,
chạy các branch feature đã được cấu hình, hợp nhất kết quả bằng RRF, lưu
candidate/selection vào PostgreSQL và cấp preview media qua R2 hoặc FFmpeg.
Service không tự submit lên hệ thống cuộc thi.

## Thành phần

- PostgreSQL full-text search cho caption, ASR và OCR; `pg_trgm` cho object
  label;
- pgvector/HNSW cho visual embedding 1024 chiều;
- query embedding, LLM và VLM qua HTTP adapter, không tải PyTorch/VLM/LLM vào
  NestJS process;
- branch isolation: branch thiếu index hoặc model được trả là unavailable,
  không làm hỏng toàn bộ search;
- R2 presigned URL cho video/keyframe và exact source-frame decode bằng FFmpeg;
- retrieval run/candidate snapshot, manual selection revision và submission
  preview JSON/CSV;
- operator token, CORS, request validation và throttling.

Các port model nằm ở `src/compute/model-ports.ts`; VLM client và visual rerank
nằm ở `src/compute/vlm-vision.client.ts` và `src/retrieval/`.

## Chạy local

Yêu cầu Node.js `>=20`, PostgreSQL có extension `vector`/`pg_trgm` và FFmpeg
trong `PATH` (hoặc đặt `FFMPEG_PATH`). Cách nhanh nhất là dùng PostgreSQL và
embedding service trong root Compose:

```powershell
Copy-Item .env.example .env
# Điền DATABASE_URL/DATABASE_DIRECT_URL và các service tùy chọn trong .env.
Set-Location ../..
docker compose up -d --build postgres embedding
Set-Location apps/backend
npm install
npm run db:migrate
npm run db:verify
npm run start:dev
```

Khi chạy backend trực tiếp trên host, database local thường dùng port `5433`
và embedding service dùng `http://127.0.0.1:8001/embed`. Khi chạy trong
Compose, root `docker-compose.yml` thay hai địa chỉ đó bằng tên service.

Migration tạo extension, bảng video/frame/evidence, feature artifact, index
release, retrieval run và manual selection. Chỉ chạy build index sau khi import
đủ dữ liệu:

```powershell
npm run db:build-indexes
npm run db:verify
```

## Ingest refined artifacts

Feature extraction thuộc `pipelines/`, không chạy trong backend runtime.
Importer validate toàn bộ input trước transaction và ghi theo quan hệ:

```text
video -> canonical frame -> frame alias -> evidence -> retrieval index
```

Chạy importer từ repository root:

```powershell
python -m pip install -r pipelines/ingestion/requirements.txt
$env:PYTHONPATH = (Get-Location).Path
python -m pipelines.ingestion.import_refined `
  --data-root D:\data\refined `
  --dry-run
```

Sau dry-run, bỏ `--dry-run`, truyền `--database-url` hoặc đặt
`DATABASE_DIRECT_URL`/`DATABASE_URL`. Có thể giới hạn bằng `--video-id` hoặc
`--limit-videos`. Import idempotent và không yêu cầu upload ma trận `.npy` lên
R2; vector local được ghi trực tiếp vào `clip_embeddings`.

## Media và exact frame

Các route frame dùng `original_frame_id` zero-based. `GET /v1/videos/:id/frames`
trả cửa sổ quanh `center_frame_id`; `limit` nhận từ `1` đến `100`. Tham số
tuỳ chọn `frame_step` nhận từ `1` đến `100.000` và chọn các keyframe gần những
mốc cách nhau theo frame nguồn; mặc định là `1`. Workbench dùng frame tâm để
xuất CSV.

Nếu thumbnail exact frame chưa tồn tại, backend seek về codec keyframe và gọi
FFmpeg để decode đúng source frame. `frame_count` (nếu có) được dùng để từ
chối ID vượt video; mọi ảnh trả về có giới hạn kích thước và có thể được nén
trước khi gửi sang VLM/VQA.

R2 dùng S3-compatible API. Object key mặc định được tổ chức như sau:

```text
datasets/<dataset-version>/videos/<video-id>.mp4
datasets/<dataset-version>/keyframes/<video-id>/<original-frame-id>.webp
features/<dataset-version>/<modality>/<model-version>/<artifact>
```

Browser chỉ gửi `video_id` và `original_frame_id`; signed URL được backend
kiểm soát. Nếu database hoặc R2 chưa cấu hình, service chuyển sang degraded
mode và health response nêu rõ dependency nào chưa sẵn sàng.

## LLM, VLM và retrieval tuning

LLM OpenAI-compatible là tùy chọn cho VQA/query improvement. VLM có thể bật
theo cấu hình backend hoặc override cho một request từ frontend; API key của
request chỉ tồn tại trong memory của tab.

Khi bật VLM, có thể dùng:

- `vlm` để trả lời VQA bằng ảnh;
- `retrieval.vlm_rerank` để chấm lại candidate bằng ảnh;
- `VLM_MIN_SCORE` để lọc candidate dưới ngưỡng;
- `VLM_QUERY_EXPANSION=true` để tạo biến thể query tiếng Anh;
- `VLM_ADAPTIVE_TOP_K=true` để co giãn số candidate gửi VLM.

Các branch retrieval hiện gồm caption, OCR lexical, ASR lexical, object và
CLIP khi database/index/query encoder tương ứng đã sẵn sàng. Branch semantic,
temporal và audio yêu cầu provider/index bổ sung.

## API

Tất cả route trừ `/health` yêu cầu header `x-operator-token` khi
`OPERATOR_TOKEN` được cấu hình. Trong development có thể bật
`ALLOW_UNAUTHENTICATED_LOCAL=true`; không dùng tùy chọn này cho staging hoặc
production.

| Method | Endpoint | Mục đích |
|---|---|---|
| `GET` | `/health` | Trạng thái database, object storage, branch và task |
| `POST` | `/v1/search` | Search đa branch, lưu candidate snapshot |
| `POST` | `/v1/search/exact-frames` | Search từ danh sách source frame đã biết |
| `POST` | `/v1/search/plan` | Xem execution plan tĩnh |
| `POST` | `/v1/query/improve` | Cải thiện query/question/event bằng LLM tùy chọn |
| `POST` | `/v1/vqa/answer` | Sinh gợi ý đáp án VQA từ frame |
| `GET` | `/v1/videos/:id/playback` | Playback URI và metadata video |
| `GET` | `/v1/videos/:id/studio` | Frame/evidence/ASR cho video studio |
| `GET` | `/v1/videos/:id/frames` | Frame lân cận quanh `center_frame_id` |
| `GET` | `/v1/videos/:id/frames/:frameId` | Metadata canonical exact frame |
| `GET` | `/v1/videos/:id/frames/:frameId/thumbnail` | Bytes thumbnail exact frame |
| `GET` | `/v1/videos/:id/keyframes/:keyframeNo` | Tra canonical frame theo alias |
| `GET` | `/v1/queries/:id/candidates` | Đọc candidate snapshot, phân trang |
| `GET` | `/v1/queries/:id/selection` | Đọc selection revision mới nhất |
| `PUT` | `/v1/queries/:id/selection` | Lưu manual selection revision mới |
| `POST` | `/v1/submissions/preview` | Validate và tạo JSON/CSV preview |

Ví dụ text search:

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

`near_frame_window_ms` lọc các kết quả quá gần nhau trong cùng video sau
fusion; đặt `0` để tắt. Search bằng source frame không cần query chữ:

```json
{
  "query": "",
  "task": "textual_kis",
  "top_k": 20,
  "frame_query": { "video_id": "L25_V078", "original_frame_id": 385 }
}
```

## Biến môi trường

Tạo `.env` từ [`.env.example`](.env.example). Các biến chính:

| Nhóm | Biến | Ý nghĩa |
|---|---|---|
| Runtime | `PORT`, `CORS_ORIGINS`, `NODE_ENV` | Port, origin được phép và môi trường |
| Auth | `OPERATOR_TOKEN`, `ALLOW_UNAUTHENTICATED_LOCAL` | Bảo vệ API; local-only escape hatch |
| Database | `DATABASE_URL`, `DATABASE_DIRECT_URL` | Pooled runtime URL và direct migration URL |
| R2 | `R2_ENDPOINT_URL`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_REGION` | Object storage và credentials |
| R2 | `R2_SIGNED_URL_TTL_SECONDS` | TTL presigned URL |
| Embedding | `EMBEDDING_SERVICE_URL`, `EMBEDDING_SERVICE_TOKEN`, `EMBEDDING_DIMENSIONS` | Query text/image encoder; mặc định 1024 chiều |
| LLM | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Provider VQA/query improvement |
| LLM | `LLM_TIMEOUT_MS`, `LLM_MAX_TOKENS`, `LLM_TEMPERATURE` | Giới hạn request và decoding |
| VLM | `VLM_ENABLED`, `VLM_BASE_URL`, `VLM_API_KEY`, `VLM_MODEL` | Vision provider mặc định |
| VLM | `VLM_TIMEOUT_MS`, `VLM_TOP_K`, `VLM_WEIGHT`, `VLM_CONCURRENCY` | Rerank/VQA runtime |
| VLM nâng cao | `VLM_MIN_SCORE`, `VLM_QUERY_EXPANSION`, `VLM_QUERY_EXPANSION_MAX_VARIANTS`, `VLM_ADAPTIVE_TOP_K` | Lọc, mở rộng query và adaptive rerank |
| Frame | `FFMPEG_PATH`, `FRAME_DECODE_TIMEOUT_MS` | Exact-frame decode/nén ảnh |
| Version | `DATASET_ID`, `DATASET_VERSION`, `PIPELINE_VERSION`, `ARTIFACT_VERSION` | Provenance của dataset và pipeline |
| Version | `INDEX_VERSION`, `INDEX_CHECKSUM`, `VERSION_STATUS`, `SCHEMA_VERSION` | Release/index validation |
| Version | `MODEL_VERSIONS_JSON` | Map tên modality sang model version |

R2 phải được cấu hình đủ cả endpoint, bucket, access key và secret; LLM/VLM
phải có cả base URL và model. Một release `active` phải có
`INDEX_VERSION` và checksum SHA-256 hợp lệ.

## Kiểm tra

```powershell
npm test
npm run test:coverage
npm run typecheck
npm run build
```

Coverage gate hiện yêu cầu statements/lines/functions từ `80%` và branches từ
`70%`. Integration tests dùng fake dependency hoặc PostgreSQL test doubles để
kiểm tra auth, search, media, frame decode, manual selection, VQA và preview.
