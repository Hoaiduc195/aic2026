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
  quality route.
- `feature_sets`/`feature_artifacts`: provenance, model/checkpoint, checksum và
  artifact storage.
- `evidence`: caption, OCR, ASR, object hoặc visual evidence; giữ
  `original_frame_id` nullable cho evidence chỉ có timeline.
- `text_evidence`, `object_evidence`, `clip_embeddings`: bảng tìm kiếm theo
  modality.
- `retrieval_runs`/`retrieval_candidates`: snapshot query và candidate theo
  frame/time identity.
- `manual_selections`: revision của thao tác chọn thủ công.

`apps/backend/sql/001_initial.sql` là baseline hiện tại. `verify_database.sql`
và `src/database/verify.ts` cùng kiểm tra một danh sách bảng, nên khi import
cần chạy cả hai bước xác minh.

## Dữ liệu refined hiện có

`aic/data/refined/` đã được chuẩn hóa theo frame-first:

- `keyframe_manifest.parquet/csv`
- `captions_en.parquet` — chỉ caption tiếng Anh
- `asr_spans.parquet` — interval theo timeline
- `embedding_index.parquet` và `embeddings/*.npy`
- `objects.parquet`
- `object_frame_manifest.parquet`

Các cột identity cũ đã được loại khỏi artifact refined. Dữ liệu vẫn là staging,
chưa import-ready vì còn thiếu canonical full-frame manifest, mapping exact
frame ở một số nguồn, R2 URI, revision đầy đủ của text encoder và 30 object
JSON bị thiếu.

## Luồng import đề xuất

1. Import `videos` và `frames` trước để tạo khóa `(video_id, original_frame_id)`.
2. Tạo `feature_sets` và `feature_artifacts` từ manifest/checksum.
3. Import từng modality vào `evidence`, rồi vào bảng con tương ứng.
4. Kiểm tra row count, frame mapping, model dimension/checkpoint và checksum.
5. Tạo index sau bulk import; chỉ activate một `index_release` đã kiểm tra.

Importer phải idempotent, parameterized và ghi rõ `inserted/updated/skipped/
failed`. Không nên import toàn bộ 873 video trước khi thử một batch nhỏ.

## Những việc còn thiếu

- Bổ sung manifest đầy đủ của video và source-frame timeline.
- Xác nhận `original_frame_id` của embedding không chỉ là row ordinal.
- Bổ sung object source bị thiếu hoặc đánh dấu rõ khi import.
- Khai báo chính xác checkpoint/revision của embedding image và text encoder.
- Upload artifact immutable lên R2 rồi mới chạy importer Neon.
