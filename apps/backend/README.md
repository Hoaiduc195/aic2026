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
- Exact source-frame preview: backend dùng FFmpeg decode on-demand khi frame chưa có thumbnail sparse.
- Ảnh sparse/ảnh decode vượt giới hạn 12 MiB sẽ được re-encode JPEG với kích thước/chất lượng giảm dần để endpoint và VQA vẫn nhận được ảnh.
- Snapshot retrieval run/candidate và manual selection có revision trong Neon.
- Export preview JSON + CSV cho Textual KIS, VQA và TRAKE, tối đa 100 answers.
- Operator token, CORS, rate limit 120 request/phút và input validation.
- Degraded mode khi Neon, R2 hoặc model service chưa được cấu hình.

Các port `LanguageModel`, `TemporalAligner` và `QueryEmbeddingProvider` nằm trong
`src/compute/model-ports.ts`; `VisionLanguageModel` và adapter OpenAI-compatible
nằm trong `src/compute/vlm-vision.client.ts`. NestJS chỉ gọi model qua HTTP, không
tải PyTorch/VLM/LLM trực tiếp.

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
video/frame, feature set/artifact, evidence, index release, retrieval và manual selection.
GIN/trigram/HNSW là index nặng nên chỉ được tạo bằng `npm run db:build-indexes`
sau khi bulk import hoàn tất.

R2 dùng S3-compatible API nên backend cần đủ endpoint, bucket, access key và
secret key. Object key được giả định theo cấu trúc:

```text
datasets/<dataset-version>/videos/<video-id>.mp4
datasets/<dataset-version>/keyframes/<video-id>/<original-frame-id>.webp
features/<dataset-version>/<modality>/<model-version>/<artifact>
```

`EMBEDDING_SERVICE_URL` là tùy chọn. Service nhận `{"text":"..."}` ở `/embed`
và raw image bytes ở `/embed/image`, cùng trả `{"embedding":[1024 số hữu hạn]}`.
Image encoder và text query encoder phải dùng
đúng cùng checkpoint/projection/normalization; chỉ cùng số chiều là chưa đủ. Khi
request có `frame_query: {"video_id":"...", "original_frame_id":385}`, backend
ưu tiên vector CLIP đã index; nếu chưa có, backend lấy exact frame từ R2/FFmpeg
và gọi image encoder. Browser chỉ gửi định danh frame, không gửi signed URL.
Nếu
chưa cấu hình, CLIP branch được đánh dấu
`unavailable`; caption/ASR/OCR/object vẫn hoạt động.

MoreVQA là nhánh tùy chọn của VQA:

- Backend lấy `frames.thumbnail_object_key`, ký presigned URL bằng R2 rồi gửi
  text cùng `image_url` tới VLM OpenAI-compatible.
- Nếu VLM lỗi, thiếu thumbnail hoặc không trả lời được, hệ thống fallback về
  LLM text hiện tại.
- Có thể bật VLM mặc định bằng `VLM_ENABLED=true`, `VLM_BASE_URL` và `VLM_MODEL`.
  Frontend cũng cho phép cấu hình VLM theo từng request; API key chỉ nằm trong
  memory của tab.
- VLM visual rerank mặc định tắt. Khi bật `retrieval.vlm_rerank`, backend chỉ
  gửi ảnh của `top_k` candidate đầu tiên và ghi trace `vlm_rerank` vào response.

Endpoint trả lời VQA là `POST /v1/vqa/answer`; request có thể thêm `vlm` với
các trường `base_url`, `api_key`, `model`, `timeout_ms`, `max_tokens` và
`temperature`.

## API

| Method | Endpoint | Mục đích |
|---|---|---|
| `GET` | `/health` | Trạng thái Neon/R2, branch và task executor |
| `POST` | `/v1/search` | Search và lưu candidate snapshot |
| `POST` | `/v1/search/plan` | Xem static all-feature execution plan |
| `GET` | `/v1/videos/:id/playback` | Presigned video URL và metadata |
| `GET` | `/v1/videos/:id/frames` | Keyframe quanh `center_frame_id` |
| `GET` | `/v1/videos/:id/frames/:frameId` | Metadata exact source frame + annotation gần nhất |
| `GET` | `/v1/videos/:id/frames/:frameId/thumbnail` | Thumbnail exact source frame; decode bằng FFmpeg nếu cần |
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
  "retrieval": { "branch_k": 200, "fusion_k": 500, "display_k": 100, "near_frame_window_ms": 1000 }
}
```

`branch_k`, `fusion_k` và `display_k` là tham số runtime. Manual mode có thể lấy
thêm candidate đã lưu bằng `GET .../candidates?limit=500&offset=0` mà không chạy
lại model. `near_frame_window_ms` lọc các kết quả quá gần nhau trong cùng video
sau bước fusion; mặc định là `1000`, còn `0` để tắt lọc.

Search bằng frame dùng request tối giản, không cần query chữ:

```json
{
  "query": "",
  "task": "textual_kis",
  "top_k": 20,
  "frame_query": { "video_id": "L25_V078", "original_frame_id": 385 }
}
```

Exact-frame preview cần `ffmpeg` trong PATH của backend hoặc đặt `FFMPEG_PATH`.
`frame_count` trong bảng `videos` được dùng để từ chối frame ID vượt quá video;
nếu chưa có `frame_count`, backend vẫn kiểm tra số nguyên không âm và để FFmpeg
xác nhận frame có tồn tại hay không. FFmpeg có timeout `FRAME_DECODE_TIMEOUT_MS`
(mặc định 15 giây); ảnh trả về được giới hạn tối đa 12 MiB và VQA chủ động nén
xuống khoảng 4 MiB để phù hợp payload multimodal.

## Ingest feature

Feature extraction vẫn thuộc `pipelines/`, không thuộc backend. Importer
dataset-specific nằm ở `pipelines/ingestion/import_refined.py`; nó đọc các
artifact đã chuẩn hóa và ghi theo transaction từng phase/video:

1. `videos`, `feature_sets`, `feature_artifacts`;
2. `frames` với exact source-frame identity;
3. `evidence` cho từng caption/ASR/OCR/object/CLIP record;
4. `text_evidence`, `object_evidence` hoặc `clip_embeddings` theo modality;
5. `index_releases`, `index_release_features` để khóa snapshot đa phương thức;
6. build search indexes, benchmark, rồi mới chuyển đúng một release sang `active`.

Importer không nằm trong backend runtime để retrieval API không phải biết cách
đọc Parquet/NumPy. Chạy `python -m pipelines.ingestion.import_refined --dry-run`
trước, rồi truyền `DATABASE_URL` của PostgreSQL local/Docker để import; các
vector local được ghi trực tiếp vào `clip_embeddings`, không yêu cầu upload
embedding lên R2.

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
