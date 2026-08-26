# Implementation plan — frame-first retrieval

## Phase 1: contracts and source timeline

1. Validate video metadata and produce a complete decoded-frame manifest.
2. Validate keyframe map rows against `(video_id, original_frame_id, timestamp_ms)`.
3. Publish frame/keyframe schemas and immutable artifact manifests.

## Phase 2: feature extraction

1. Normalize English captions, OCR and object detections per frame.
2. Normalize ASR as timeline spans with `start_ms/end_ms`.
3. Store embedding matrices plus model/checkpoint/revision metadata.
4. Keep empty detections and missing-source rows explicit.

## Phase 3: database and importer

1. Create `videos`, `frames`, feature/artifact, evidence and search tables.
2. Import frame identity before modality rows.
3. Validate dimensions, checksums, provenance and row counts.
4. Build search indexes after bulk import and activate one release.

## Phase 4: retrieval

1. Build deterministic query plans with frame as the only target unit.
2. Run independent visual, caption, OCR, ASR and object branches.
3. Fuse hits by frame identity with weighted RRF.
4. Persist raw internal preview URI; sign it only at the response boundary.

## Phase 4A: agent-assisted exhaustive video verification

Mục tiêu của phase này là không dừng ở frame đứng hạng nhất. Feature retrieval
chỉ dùng để tìm các video tiềm năng; agent phải duyệt sâu theo thứ tự điểm.

1. Lấy global top-k frame từ feature retrieval, sau đó group và rank lại thành
   danh sách video duy nhất (`video_rank`). Không để một video chiếm toàn bộ
   quota; giữ lại `per_video_k` frame seed cho mỗi video.
2. Tạo một verification run có `run_id`, query đã chuẩn hóa, `index_version`,
   `video_budget` (mặc định 10) và `frame_batch_size` (8–16).
3. Với từng video theo thứ tự `video_rank`, MCP/agent lấy frame inventory và
   duyệt hết các frame trong phạm vi video đó theo batch. Mỗi batch phải trả
   `candidate_id`, `video_id`, `original_frame_id`, timestamp và judgment ngắn.
   Không gửi toàn bộ ảnh hoặc raw evidence vào context một lần.
4. Lưu checkpoint sau mỗi batch: `video_id`, cursor, `frames_examined`,
   `frames_total`, `status`. Nếu session hoặc mạng bị ngắt, run phải resume từ
   cursor cuối, không bắt đầu lại.
5. Chỉ kết thúc khi đã duyệt hết các video trong `video_budget`, hoặc người dùng
   chủ động dừng. Không được dừng sớm chỉ vì đã thấy một hit ở top 1.
6. Trả kết quả theo `video_rank` và độ phù hợp frame, kèm coverage:
   `videos_examined`, `frames_examined`, `frames_total`, `completed` và
   `unverified_videos`.

Agent không được tự đọc PostgreSQL/R2 hay toàn bộ dataset. Backend/MCP chịu
trách nhiệm phân trang, quyền truy cập và ánh xạ chính xác
`video_id + original_frame_id`; agent chỉ nhận các batch nhỏ và đưa ra judgment.
Không tạo một LLM agent riêng cho từng video: dùng một coordinator với tool
loop giới hạn hoặc worker không dùng LLM để tránh nhân token theo số video.

### Scope clarification

The initial top-k remains a frame-level feature search. Its only purpose in
Phase 4A is to produce a ranked set of distinct `video_id` values. The agent
then expands each selected `video_id` back to that video's complete frame
inventory and checks those frames, rather than checking only the original
top-k frames. Therefore a frame ranked 8 can cause its entire source video to
be examined even when the frame ranked 1 belongs to another video.

## Phase 5: workbench and evaluation

1. Display exact frame, evidence and neighboring frames from the source map.
2. Save manual answers as immutable revisions.
3. Measure Recall@K, MRR, evidence coverage, duplicate rate and latency.
4. Add end-to-end tests for search, playback, frame context and submission preview.
5. Evaluate agent verification separately from coarse retrieval: frame recall
   inside the selected top-N videos, exact-frame accuracy, coverage ratio,
   latency p50/p95, tool-call count and total/reasoning tokens.

## Current gate

Backend and frontend tests are green. Refined artifacts remain staging-only
until exact frame mapping, R2 object keys and embedding revision are resolved.

Local dump hiện có `schema_migrations` checksum của `001_initial.sql` khác file
trong repo, nên `npm run db:migrate` chủ động dừng để tránh sửa schema mù. Pilot
đã áp dụng riêng migration 004/005 idempotent trên DB local. Trước khi chia sẻ DB,
team phải chọn một trong hai cách: dựng lại DB từ migration hiện tại rồi import
artifact, hoặc audit schema và chốt thủ tục repair checksum; không tự sửa checksum.

### Phase 4A status (implemented MVP)

- [x] Migration `004_agent_verification.sql` tao checkpoint table
  `agent_verification_runs`.
- [x] API `POST /v1/agent/frame-search` tao coarse search va xep hang video duy nhat.
- [x] API `GET .../:runId/batch` phan trang keyframe theo `original_frame_id`.
- [x] API `POST .../:runId/judgments` bat buoc judgment day du tung frame trong batch.
- [x] API `GET .../:runId` tra coverage va trang thai resume; `POST .../:runId/stop`
  dung an toan ma khong mat checkpoint.
- [x] MCP stdio bridge nam o `apps/backend/src/agent/mcp-server.ts`.
- [x] REST worker tu dong xem thumbnail qua VLM; CLIP auto-reject/auto-accept va
  chi goi VLM cho vung score mo ho.
- [x] Migration `005_agent_worker_leases.sql`: moi run co query embedding, worker
  lease, heartbeat va resume; hai worker dung hai `run_id` rieng.
- [x] Query embedding cache/in-flight coalescing de UI va worker dung chung local
  embedding service ma khong encode lai cung mot query.
- [x] Pilot mot worker/mot query: 4 frame trong 9.6 giay, 3 auto-reject bang
  CLIP, 1 VLM review; giam 75% VLM call o batch thu.
- [ ] Chot cung checkpoint/projection giua image embedding va text query encoder
  truoc khi bat CLIP query rewrite trong production.
- [ ] Calibrate hai nguong CLIP tren ground-truth; pilot chi xac nhan do on dinh,
  chua du de ket luan accuracy.
- [ ] Sau khi pilot duoc chap nhan, chay hai worker song song tren hai `run_id`
  va do latency p50/p95 cung tai CPU embedding service.
