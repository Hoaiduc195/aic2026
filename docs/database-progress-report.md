# Database progress report — frame-first architecture

## Kết luận hiện tại

Database dùng mô hình:

```text
video → exact source frame → evidence → retrieval candidate
```

Không có bảng hay khóa trung gian cho temporal grouping. ASR vẫn là evidence
dạng khoảng thời gian `[start_ms, end_ms)`, còn kết quả hiển thị luôn cố gắng
trỏ về `original_frame_id` cụ thể.

## Schema đã chốt

- `videos`: metadata và `object_key` của video trong R2.
- `frames`: khóa chính `(video_id, original_frame_id)`, timestamp, thumbnail và
  quality route. Đây là một dòng canonical cho mỗi source frame.
- `frame_aliases`: giữ từng lần xuất hiện của keyframe/map, khóa chính
  `(video_id, keyframe_no)`, và trỏ về frame canonical bằng
  `(video_id, original_frame_id)`. Vì vậy hai keyframe khác nhau có thể cùng
  trỏ đến một frame canonical mà không tạo hai frame canonical. Các trường
  `keyframe_no`/thumbnail trong `frames` chỉ là occurrence đại diện để tương
  thích với API cũ; danh sách đầy đủ nằm ở `frame_aliases`.
- `feature_sets`/`feature_artifacts`: provenance, model/checkpoint, checksum và
  artifact storage.
- `evidence`: caption, OCR, ASR, object hoặc visual evidence; giữ
  `original_frame_id` nullable cho evidence chỉ có timeline.
- `text_evidence`, `object_evidence`, `clip_embeddings`: bảng tìm kiếm theo
  modality.
- `retrieval_runs`/`retrieval_candidates`: snapshot query và candidate theo
  frame/time identity.
- `manual_selections`: revision của thao tác chọn thủ công.

`apps/backend/sql/001_initial.sql` là baseline gốc; `002_add_frame_aliases.sql`
thêm bảng alias và `003_backfill_frame_aliases.sql` backfill alias đại diện cho
DB đã có dữ liệu. `verify_database.sql` và `src/database/verify.ts` cùng kiểm
tra một danh sách bảng, nên khi import cần chạy cả hai bước xác minh.

## Dữ liệu refined hiện có

`aic/data/refined/` đã được chuẩn hóa theo frame-first:

- `keyframe_manifest.parquet/csv`
- `canonical_frame_candidates.parquet/csv` — one representative candidate per
  `(video_id, original_frame_id)`; duplicate occurrences are represented by
  `frame_aliases`.
- `frame_aliases.parquet/csv` — every keyframe/map occurrence keyed by
  `(video_id, keyframe_no)`, including occurrences that share one canonical
  frame candidate.
- `source_map_index.parquet/csv` — coverage summary for the authoritative
  sparse `map-keyframes` files.
- `captions_en.parquet` — chỉ caption tiếng Anh
- `asr_spans.parquet` — interval theo timeline
- `embedding_index.parquet` và `embeddings/*.npy`
- `objects.parquet`
- `object_frame_manifest.parquet`

Caption dùng tiếng Anh (`language = en`); OCR là modality tiếng Việt
(`language = vi`). Không tạo hoặc import `caption_vi`.

Các cột identity cũ đã được loại khỏi artifact refined. Map `map-keyframes` đã
được kiểm tra đủ 873 video và 177.321 occurrence; `original_frame_id` hiện là
`frame_idx` chính xác trong video, với 176.707 canonical frame và các occurrence
trùng vẫn được giữ nguyên. Đây là sparse selected-frame map, không phải manifest
liệt kê mọi frame của video.

Dữ liệu có thể import vào PostgreSQL + pgvector local bằng
`pipelines/ingestion/import_refined.py`; vector `.npy` được đọc trực tiếp từ
local nên không bắt buộc upload lên R2. Exact revision của text encoder vẫn là
điều kiện để bật visual text-to-vector retrieval khi chạy backend.

## Luồng import đề xuất

1. Import `videos` và `frames` trước để tạo khóa `(video_id, original_frame_id)`.
2. Import toàn bộ map/keyframe occurrences vào `frame_aliases` bằng khóa
   `(video_id, keyframe_no)`; không loại bỏ các dòng trùng
   `original_frame_id`.
3. Tạo `feature_sets` và `feature_artifacts` từ manifest/checksum.
4. Import từng modality vào `evidence`, rồi vào bảng con tương ứng.
5. Kiểm tra row count, frame mapping, model dimension/checkpoint và checksum.
6. Tạo index sau bulk import; chỉ activate một `index_release` đã kiểm tra.

Ở tầng retrieval, các alias vẫn có thể xuất hiện như hai hit đầu vào, nhưng
fusion gom chúng theo `(video_id, original_frame_id)`. Kết quả hiển thị vì thế
chỉ có một canonical frame; `occurrence_count`/evidence vẫn có thể cho biết có
bao nhiêu alias cùng đóng góp.

Importer phải idempotent, parameterized và ghi rõ `inserted/updated/skipped/
failed`. Không nên import toàn bộ 873 video trước khi thử một batch nhỏ.

## Những việc còn thiếu

- Khai báo chính xác revision của text encoder.
- Chạy bulk import local, kiểm tra row count/checksum, rồi mới build HNSW/GIN indexes.
