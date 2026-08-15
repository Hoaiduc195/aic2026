# AIC 2026 retrieval backend

NestJS backend cho ba task vòng sơ tuyển: `textual_kis`, `vqa`, `trake`.
Backend chạy retrieval trên toàn bộ feature đã ingest, hợp nhất bằng RRF, lưu top-k
vào Neon để nhóm duyệt thủ công, và chỉ tạo submission preview. Backend không tự
submit lên hệ thống cuộc thi.

## Thành phần đã cài đặt

- PostgreSQL FTS cho caption, ASR và OCR; `pg_trgm` cho object label.
- pgvector/HNSW cho visual embedding 1024 chiều; query encoder chạy qua HTTP interface riêng.
- Branch isolation: một index/model lỗi không làm hỏng toàn bộ search.
- R2 presigned URL cho video playback và keyframe thumbnail.
- Snapshot retrieval run/candidate và manual selection có revision trong Neon.
- Export preview JSON + CSV cho Textual KIS, VQA và TRAKE, tối đa 100 answers.
- Operator token, CORS, rate limit 120 request/phút và input validation.
- Degraded mode khi Neon, R2 hoặc model service chưa được cấu hình.

Các port `LanguageModel`, `VisionLanguageModel`, `TemporalAligner` và
`QueryEmbeddingProvider` nằm trong `src/compute/model-ports.ts`. NestJS không tải
PyTorch/VLM/LLM trực tiếp.

## Cấu hình và chạy

```powershell
Copy-Item .env.example .env
npm install
npm run db:migrate
npm run db:verify
# Sau khi bulk import feature:
npm run db:build-indexes
npm run start:dev
```

Neon nên dùng pooled URL cho `DATABASE_URL` và direct URL cho
`DATABASE_DIRECT_URL`. Migration tạo extension `vector`, `pg_trgm` cùng các bảng
video/frame/segment, feature set/artifact, evidence, index release, retrieval và manual selection.
GIN/trigram/HNSW là index nặng nên chỉ được tạo bằng `npm run db:build-indexes`
sau khi bulk import hoàn tất.

R2 dùng S3-compatible API nên backend cần đủ endpoint, bucket, access key và
secret key. Object key được giả định theo cấu trúc:

```text
datasets/<dataset-version>/videos/<video-id>.mp4
datasets/<dataset-version>/keyframes/<video-id>/<original-frame-id>.webp
features/<dataset-version>/<modality>/<model-version>/<artifact>
```

`EMBEDDING_SERVICE_URL` là tùy chọn. Service nhận `{"text":"..."}` và trả
`{"embedding":[1024 số hữu hạn]}`. Image encoder và text query encoder phải dùng
đúng cùng checkpoint/projection/normalization; chỉ cùng số chiều là chưa đủ. Nếu
chưa cấu hình, CLIP branch được đánh dấu
`unavailable`; caption/ASR/OCR/object vẫn hoạt động.

## API

| Method | Endpoint | Mục đích |
|---|---|---|
| `GET` | `/health` | Trạng thái Neon/R2, branch và task executor |
| `POST` | `/v1/search` | Search và lưu candidate snapshot |
| `POST` | `/v1/search/plan` | Xem static all-feature execution plan |
| `GET` | `/v1/videos/:id/playback` | Presigned video URL và metadata |
| `GET` | `/v1/videos/:id/frames` | Keyframe quanh `center_frame_id` |
| `GET` | `/v1/queries/:id/candidates` | Manual top-k, `limit` 1-1000 |
| `GET` | `/v1/queries/:id/selection` | Revision lựa chọn gần nhất |
| `PUT` | `/v1/queries/:id/selection` | Lưu revision manual mới |
| `POST` | `/v1/submissions/preview` | Validate và tạo JSON/CSV; không submit |

Ví dụ search:

```json
{
  "query": "Người phụ nữ đang cầm vật gì?",
  "task": "vqa",
  "top_k": 20,
  "retrieval": { "branch_k": 200, "fusion_k": 500, "display_k": 100 }
}
```

`branch_k`, `fusion_k` và `display_k` là tham số runtime. Manual mode có thể lấy
thêm candidate đã lưu bằng `GET .../candidates?limit=500&offset=0` mà không chạy
lại model.

## Ingest feature

Feature extraction vẫn thuộc `pipelines/`, không thuộc backend. Job ingest cần
chuẩn hóa Parquet/JSON thành các bảng sau theo transaction từng artifact/video:

1. `videos`, `feature_sets`, `feature_artifacts`;
2. `segments`, `frames` với exact source-frame identity;
3. `evidence` cho từng caption/ASR/OCR/object/CLIP record;
4. `text_evidence`, `object_evidence` hoặc `clip_embeddings` theo modality;
5. `index_releases`, `index_release_features` để khóa snapshot đa phương thức;
6. build search indexes, benchmark, rồi mới chuyển đúng một release sang `active`.

Repository hiện không chứa Parquet dataset thật để suy ra an toàn tên cột, vì
vậy importer dataset-specific chưa được hardcode vào backend. Khi artifact
manifest có schema ổn định, importer chỉ cần ghi vào các bảng trên; retrieval API
không phải thay đổi.

## Kiểm tra

```powershell
npm test
npm run test:coverage
npm run typecheck
npm run build
```

Coverage gate: statements/lines/functions từ 80%, branches từ 70%. Integration
test dùng Supertest kiểm tra operator auth, search, media, manual selection và
submission preview.
