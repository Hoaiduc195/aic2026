# Báo cáo tiến độ Database — Neon PostgreSQL/pgvector

**Cập nhật:** 2026-08-15
**Phạm vi:** database và ingestion cho hệ thống retrieval
**Repo:** `D:\VSCode\AIC\aic2026`
**Trạng thái tổng thể:** schema baseline đã tối ưu và validate; Neon development đã xác nhận; chưa migrate persistent và chưa import dữ liệu

## 0. Cập nhật quan trọng cho người đang giữ file feature local

### 0.1. Những chỗ vừa sửa trong database schema

`apps/backend/sql/001_initial.sql` đã được tối ưu lại trước migration đầu tiên:

1. **Thêm `feature_sets`:** lưu provenance/model/version một lần cho mỗi bộ feature, không lặp các chuỗi `producer`, `model_version`, `dataset_version` trên hàng trăm nghìn hoặc hàng triệu evidence.
2. **Thêm `feature_artifacts`:** đăng ký từng file `.parquet`, `.json`, `.jsonl`, `.npy` bằng URI, SHA-256, size, record count và video. Evidence chỉ giữ `artifact_id` + `source_record_index`, tránh lặp nguyên đường dẫn file ở từng row và vẫn truy ngược được row nguồn.
3. **Thu gọn `evidence`:** chuyển provenance sang `feature_sets`, nguồn file sang `feature_artifacts`; giữ các trường phục vụ join/search là video, segment, frame, interval, confidence và payload nhỏ.
4. **Thu gọn `clip_embeddings`:** chỉ giữ `embedding_id`, `evidence_id` và `vector(1024)`. Model/dtype/normalization nằm ở `feature_sets`, tránh lặp metadata cho từng vector.
5. **Object bbox đổi từ JSONB sang `real[]`:** bắt buộc đúng bốn phần tử; normalized bbox còn bị chặn trong `[0,1]`. Cách này gọn hơn JSONB và phát hiện dữ liệu bbox hỏng ngay lúc import.
6. **Object key R2 không còn hard-code `videos/%` hoặc `keyframes/%`:** chấp nhận prefix có version như `datasets/aic2026/v1/...`, nhưng vẫn chặn key rỗng, whitespace, query/fragment và path traversal.
7. **Tăng integrity:** frame/evidence phải cùng video với segment; artifact và evidence phải cùng feature set; ingestion counter không được vượt `records_seen`; trạng thái hoàn thành/thất bại bắt buộc có `finished_at`.
8. **Tách index nặng khỏi migration:** GIN/trigram/HNSW được chuyển sang `sql/post_import_indexes.sql` và chạy bằng `npm run db:build-indexes` sau bulk import. Lý do là cập nhật HNSW cho từng vector trong lúc import làm nạp dữ liệu chậm và tốn tài nguyên hơn.
9. **Thêm `index_releases` + `index_release_features`:** một index version ánh xạ chính xác tới một feature set của từng modality. Chỉ một release được `active`; CLIP, caption/OCR/ASR và object đều lọc bằng `plan.index_version`. Điều này ngăn một query trộn caption/object/embedding của các dataset hoặc model version khác nhau.

### 0.2. D1–D4 hiện tại

- [x] **D1 — Neon branch:** đã xác nhận pooled/direct connection đều thuộc branch `development`.
- [ ] **D2 — Embedding manifest:** người giữ feature phải xác nhận exact model/checkpoint, revision, preprocessing, projection, 1024 dimensions, dtype, L2 normalization và text query encoder tương thích. Chỉ tên `vit32b` là chưa đủ.
- [~] **D3 — Nguồn import:** team đã trích xuất feature thành `.parquet`/`.json` và giao một người giữ local. Các file này là nguồn import thực tế, nhưng phải inventory + validate + ánh xạ về canonical frame/segment trước khi đưa lên Neon.
- [~] **D4 — R2:** team đã chốt video và keyframe sẽ nằm trên R2. Việc còn lại là upload, chốt object-key convention, lấy ETag/version/checksum và ghi URI tương ứng vào video/keyframe manifest. Nên backup cả feature artifact gốc lên R2; Neon chỉ giữ bản đã materialize để search.

### 0.3. Checklist bắt buộc cho người giữ feature

Không gửi file rời rồi import ngay. Trước tiên tạo một inventory cho từng artifact với tối thiểu:

```text
artifact_type
local_path
file_format
sha256
size_bytes
record_count
column_names_and_types
video_count
first_video_id / last_video_id
producer
model_name
model_version_or_revision
pipeline_version
schema_version
identity_columns
null_count_by_required_column
duplicate_identity_count
```

Riêng embedding phải có thêm:

```text
embedding_dimensions=1024
dtype=float16|float32
l2_normalized=true|false
row_to_frame_mapping
text_encoder_name_and_revision
```

Không được import nếu chỉ có số thứ tự `001`, `002`, ... mà thiếu bảng ánh xạ `(video_id, n) → original_frame_id → timestamp_ms → segment_id`. File local đang là một điểm lỗi duy nhất; cần giữ ít nhất hai bản và ưu tiên upload artifact bất biến lên prefix R2 `features/<dataset_version>/<modality>/<model_version>/...`.

## 1. Kết luận ngắn

Đúng, phải chốt schema và quy tắc ánh xạ artifact trước khi tải dữ liệu lên Neon. Nếu import trước khi chốt `segment_id`, `original_frame_id`, timestamp, model embedding và version, dữ liệu giữa caption/OCR/ASR/object/embedding có thể không join được hoặc phải xóa rồi import lại.

Hiện tại database Neon kết nối được nhưng còn trống. Đây là thời điểm an toàn để review và chốt `001_initial.sql`. Sau khi migration này được áp dụng lần đầu, không được sửa lại file `001`; mọi thay đổi tiếp theo phải tạo migration `002_...sql`.

## 2. Những phần đã hoàn thành

- [x] Đúng codebase: `D:\VSCode\AIC\aic2026` trên nhánh Git `main`.
- [x] Node.js `v24.19.0`, đáp ứng yêu cầu `>=20` của backend và Neon CLI.
- [x] Có `apps/backend/.env.example` làm mẫu.
- [x] `apps/backend/.env` đã được Git bỏ qua; secret không xuất hiện trong báo cáo hoặc log kiểm tra.
- [x] `DATABASE_URL` được xác nhận là pooled URL cho runtime.
- [x] `DATABASE_DIRECT_URL` được xác nhận là direct URL cho migration/import tác vụ dài.
- [x] Cả hai URL kết nối thành công tới PostgreSQL Neon bằng truy vấn chỉ đọc.
- [x] Trạng thái database hiện tại: chưa có extension `vector`, `pg_trgm`, chưa có bảng public.
- [x] `npm run db:verify` đã được thử trước migration và fail đúng với danh sách extension/bảng còn thiếu; không có thao tác ghi dữ liệu.
- [x] Migration runner hỗ trợ nhiều file SQL, transaction theo migration, advisory lock, checksum SHA-256 và chống sửa migration đã chạy.
- [x] Baseline DB dùng `vector(1024)`; HNSW cosine được build sau bulk import.
- [x] Provenance đã chuẩn hóa qua `feature_sets`, artifact file qua `feature_artifacts`.
- [x] Có schema theo dõi ingestion idempotent/resume bằng checksum và số lượng record.
- [x] Runtime lưu và đọc lại `fusion_trace` thay vì làm mất dấu đóng góp của từng retrieval channel.
- [x] Có `npm run db:verify` và script SQL chỉ đọc `apps/backend/sql/verify_database.sql`.
- [x] Backend typecheck/build thành công và 50/50 test pass sau các thay đổi hiện tại.
- [x] Toàn bộ `001_initial.sql` đã chạy thành công trong transaction thử nghiệm trên Neon development: tạo được 15 bảng ứng dụng và `vector(1024)`; sau `ROLLBACK`, database vẫn có 0 bảng public.

## 3. Việc chưa được phép thực hiện

- [x] Hai connection string trong `.env` đã được xác nhận thuộc Neon branch `development`.
- [ ] Chưa chạy persistent `npm run db:migrate`; schema transaction test đã pass và đây là bước tiếp theo.
- [ ] Chưa tải dữ liệu thật lên Neon.
- [ ] Chưa chuyển version manifest từ `staged` sang `active`.

## 4. Schema database baseline đã đề xuất chốt

### 4.1. Quy tắc nền tảng

- Đơn vị retrieval mặc định là canonical `segment`.
- Timeline dùng integer milliseconds và interval nửa mở `[start_ms, end_ms)`.
- Định danh frame chính xác là `(video_id, original_frame_id)`, không dùng số thứ tự ảnh `001.jpg` làm frame gốc.
- Mọi frame/evidence phải thuộc segment của cùng video; foreign key trong DB chặn map chéo video.
- Embedding production có đúng 1024 chiều, dùng cosine, phải ghi model name/version, dtype và trạng thái normalize.
- Raw video, keyframe và file artifact lớn nằm ở R2; Neon giữ metadata/search fields và vector cần truy vấn.
- Mọi dữ liệu có provenance: dataset, pipeline, schema/model version và URI artifact nguồn.

### 4.2. Các bảng và dữ liệu lưu

| Bảng | Vai trò | Dữ liệu chính |
|---|---|---|
| `schema_migrations` | lịch sử migration | tên file, checksum SHA-256, thời gian apply |
| `videos` | catalog video | R2 URI/object key, duration, FPS phân số, kích thước, checksum/ETag/version |
| `feature_sets` | version/provenance feature bất biến | modality, producer/model, dimension/dtype/normalize và manifest checksum |
| `feature_artifacts` | catalog file nguồn | URI local/R2, SHA-256, size, row count và video |
| `index_releases` | snapshot retrieval đa phương thức | dataset/index checksum, staged/active/retired |
| `index_release_features` | khóa feature theo release | mỗi modality của index version dùng đúng một feature set |
| `segments` | timeline canonical | frame/time range, ordinal, neighbor, source, confidence |
| `frames` | retrieval keyframe | exact frame ID, timestamp, segment, R2 thumbnail, quality route |
| `evidence` | record cha chung | feature/artifact source, video/segment/frame, interval, confidence và payload nhỏ |
| `text_evidence` | caption/OCR/ASR | raw text, normalized text, language, PostgreSQL FTS + trigram |
| `object_evidence` | object detection | COCO class/label, confidence, bbox, normalized bbox, track/attributes |
| `clip_embeddings` | visual vector | embedding ID và vector(1024); model space lấy từ `feature_sets` |
| `ingestion_runs` | resume/audit importer | source checksum, target, counters, checkpoint, errors, status |
| `retrieval_runs` | snapshot query | query, task, QueryPlan, dataset/index version |
| `retrieval_candidates` | snapshot kết quả | rank, score, evidence, modalities và `fusion_trace` |
| `manual_selections` | kết quả người duyệt | revision, task, answers, note |

Schema nguồn: `apps/backend/sql/001_initial.sql`.

## 5. Ánh xạ artifact vào Neon

Ưu tiên import artifact canonical do `pipelines/main` sinh:

| Artifact | Cách import |
|---|---|
| video manifest | một row → `videos` |
| `canonical/{video_id}/segments.jsonl` | một row → `segments` |
| `canonical/{video_id}/keyframes.jsonl` | một row → `frames`; bắt buộc exact `original_frame_id`, `timestamp_ms`, `segment_id` |
| `canonical/{video_id}/captions.jsonl` | một caption → `evidence(type=caption)` + một hoặc hai `text_evidence` tùy chính sách ngôn ngữ |
| `canonical/{video_id}/ocr.jsonl` | một frame OCR → `evidence(type=ocr)` + `text_evidence`; box chi tiết giữ trong payload |
| `canonical/{video_id}/asr.jsonl` | mỗi span đã cắt theo canonical segment → `evidence(type=asr)` + `text_evidence` |
| `canonical/{video_id}/objects.jsonl` | unnest từng detection → một `evidence(type=object)` + `object_evidence` |
| `canonical/{video_id}/embeddings.jsonl` + `.npy` | join theo đúng thứ tự/embedding ID → `evidence(type=frame)` + `clip_embeddings` |

Thứ tự import bắt buộc:

```text
videos
  → feature_sets
    → feature_artifacts
      → segments
        → frames
          → evidence
            → text_evidence / object_evidence / clip_embeddings
```

Mỗi artifact phải được validate contract, tính SHA-256, ghi `ingestion_runs`, import trong transaction và có thể chạy lại mà không nhân đôi dữ liệu.

## 6. Quy tắc cho dữ liệu legacy đang có trên Kaggle

Các file như `captioning/L26_V076/001.txt`, OCR JSON hoặc object JSON dùng `001` như số thứ tự keyframe, không được coi trực tiếp là `original_frame_id`.

Adapter legacy phải:

1. Đọc `video_id` từ tên thư mục và `n` từ tên file.
2. Join `(video_id, n)` với retrieval keyframe manifest để lấy exact `original_frame_id` và `timestamp_ms`.
3. Join frame đó vào canonical segment theo `segment_id`; nếu chưa có ID thì map bằng frame range hoặc interval nửa mở.
4. Reject record không map được, record map vào `*-seg-unknown`, timestamp ngoài video hoặc ID trùng nhưng payload khác.
5. Chỉ sau bước normalize này mới import vào Neon.

## 7. Bốn quyết định còn phải chốt với team trước khi import

### D1 — Neon branch

**Đã hoàn thành:** pooled/direct URL đều lấy từ branch `development`.

### D2 — Manifest embedding 1024 chiều

Team cần cung cấp chính xác:

- model architecture/checkpoint và revision;
- preprocessing/resolution;
- projection head;
- L2 normalization;
- dtype;
- SHA-256 của `.npy`/manifest;
- text query encoder dùng đúng joint embedding space.

Tên gọi `vit32b` và số chiều 1024 chưa đủ để đảm bảo text query vector tương thích với image vector. Pipeline `pipelines/main/tasks/visual_embedding/local.py` hiện mặc định model khác, nên không được trộn output mặc định đó vào index `vit32b` nếu chưa xác minh.

### D3 — Nguồn import chính thức

Nguồn hiện tại là các file `.parquet`/`.json` do team trích xuất và một thành viên giữ local. Người đó phải xác định mỗi file thuộc dạng nào:

- đã canonical: có exact `video_id`, `original_frame_id`, `timestamp_ms`, `segment_id`;
- legacy: phải đi qua adapter ánh xạ `n → original_frame_id → segment_id`.

Không import lẫn hai nguồn vào cùng `dataset_version` nếu chưa có quy tắc dedup/provenance.

### D4 — Vị trí keyframe/artifact production

**Đã chốt kiến trúc:** video và keyframe phục vụ qua R2. Còn phải hoàn thành upload, manifest object key/URI/ETag/version/checksum. Feature file nguồn cũng nên được backup bất biến lên R2, còn vector/text/object searchable được materialize vào Neon.

## 8. Các bước thực hiện ngay sau khi D1–D4 được xác nhận

### Bước 1 — Migration trên development branch

```powershell
Set-Location D:\VSCode\AIC\aic2026\apps\backend
node --version
npm run db:migrate
npm run db:verify
```

Kỳ vọng lần đầu:

```text
Applied 001_initial.sql
Database migrations are up to date
```

Chạy lại phải nhận `Skipped 001_initial.sql (already applied)`. Nếu báo checksum mismatch, dừng lại; không xóa record migration để ép chạy.

### Bước 2 — Kiểm tra schema

Chạy `npm run db:verify`. Nếu muốn kiểm tra trực tiếp trên Neon UI, mở SQL Editor của branch `development` và chạy nội dung `apps/backend/sql/verify_database.sql`.

Kỳ vọng:

- có `vector` và `pg_trgm`;
- có đầy đủ bảng ở mục 4.2;
- `embedding_type = vector(1024)`;
- trước import, mọi count dữ liệu bằng 0.

### Bước 3 — Pilot import

Chỉ import 1–3 video trước. Kiểm tra FK, count, mapping frame/segment, FTS, object filter và vector dimension. Không import toàn bộ 873 video ngay từ đầu.

### Bước 4 — Batch import

Import theo dependency, checkpoint theo artifact/video và ghi lỗi riêng. Record lỗi không được làm rollback các video đã hoàn thành ở transaction trước.

Sau khi bulk import hoàn thành:

```powershell
npm run db:build-indexes
npm run db:verify
```

### Bước 5 — Validation và benchmark

- count giữa artifact và DB phải khớp;
- mọi evidence map đúng video/segment;
- embedding chỉ có một compatible model space;
- query caption/OCR/ASR/object trả evidence thật;
- query vector top-k chạy bằng HNSW;
- đo recall và p50/p95 trước khi activate.

## 9. Gate chuyển `staged` → `active`

- [ ] Migration development thành công và rerun idempotent.
- [ ] Schema verification pass.
- [ ] Pilot import pass, không có record mồ côi.
- [ ] Full import hoàn tất hoặc lỗi đã được team chấp nhận rõ ràng.
- [ ] Embedding đều 1024 chiều, normalize đúng và cùng model space.
- [ ] Text query encoder tương thích với image encoder.
- [ ] FTS/trigram/HNSW query trên dữ liệu thật hoạt động.
- [ ] Integration tests trên Neon pass.
- [ ] Benchmark recall/latency đạt ngưỡng team chốt.
- [ ] Có `DATASET_VERSION`, `INDEX_VERSION`, `INDEX_CHECKSUM` và phương án rollback.
- [ ] `index_releases` active ánh xạ đầy đủ các modality đã bật và đúng `plan.index_version`.

## 10. Tiến độ theo phase DB

| Hạng mục | Trạng thái | Ghi chú |
|---|---|---|
| Secret và connection config | Hoàn thành | `.env` ignored, pooled/direct hợp lệ |
| Kiểm tra kết nối read-only | Hoàn thành | Neon reachable, DB trống |
| Migration runner | Hoàn thành | lock + transaction + checksum |
| Baseline SQL schema | Hoàn thành | transaction test trên Neon development đã pass và rollback sạch |
| Embedding schema 1024 | Hoàn thành về cấu trúc | model manifest còn chờ team |
| Ingestion audit schema | Hoàn thành | contract đã đồng bộ `ingestion_runs` |
| Migration Neon | Sẵn sàng | branch `development` và SQL đã xác nhận |
| Importer canonical/legacy | Chưa bắt đầu | cần inventory file local và model manifest |
| Pilot/full data import | Chưa bắt đầu | phụ thuộc migration + importer |
| Integration/benchmark | Chưa bắt đầu | phụ thuộc dữ liệu thật |
| Activate index | Chưa được phép | giữ `VERSION_STATUS=staged` |

## 11. Nguyên tắc rollback

- Trước full import, tạo Neon branch/snapshot có tên rõ ràng.
- Import theo `dataset_version`/`pipeline_version`, không overwrite âm thầm dữ liệu version khác.
- Nếu pilot lỗi, rollback transaction của artifact đó và giữ `ingestion_runs.status=failed` cùng lỗi đã sanitize.
- Không sửa migration đã apply; tạo migration mới.
- Không chuyển manifest active cho tới khi toàn bộ gate ở mục 9 pass.

## 12. Việc người phụ trách cần xác nhận tiếp theo

D1 và schema transaction test đã hoàn thành. Người giữ feature cần gửi inventory không chứa secret theo mục 0.3, giải quyết D2, phân loại file D3 và phối hợp upload/manifest R2 ở D4. Bước kỹ thuật kế tiếp là migration development, pilot importer 1–3 video, bulk import, build index rồi benchmark. Không gửi password hoặc nguyên connection string trong chat.
