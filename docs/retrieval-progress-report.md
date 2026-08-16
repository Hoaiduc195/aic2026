# Retrieval progress report — frame-first

## Trạng thái

Retrieval backend đã hoàn thành ở mức code, contract và unit test. Identity
chính của candidate là `video_id + original_frame_id`; nếu evidence chỉ có
timeline thì dùng `video_id + start_ms + end_ms` làm fallback ổn định.

## Đã hoàn thành

- Query planner chọn branch theo tín hiệu visual/OCR/ASR/object và chỉ phát
  `target_granularities: ["frame"]`.
- PostgreSQL branches đọc caption, OCR, ASR, object và CLIP evidence mà không
  cần khóa temporal trung gian.
- Fusion gom nhiều evidence của cùng source frame, dùng weighted RRF và giữ
  `fusion_trace` để audit.
- Candidate snapshot lưu `original_frame_id`, interval, evidence IDs,
  modality và score.
- Preview URI nội bộ dùng `r2://media/<object-key>`; backend mới ký URL khi
  trả response, không lưu signed URL vào database.
- Nếu keyframe preview thiếu, backend fallback về `videos.object_key`.
- Auth, rate limit, degraded mode và health check đã có test.

## Identity và ASR

Frame evidence có `original_frame_id` và `timestamp_ms`. ASR không bị cắt theo
một grouping nào; nó giữ `start_ms/end_ms`, text và provenance. Khi trả kết quả
cho UI, ASR candidate nên được anchor vào source frame gần nhất nếu query cần
một frame để người dùng chọn.

## API response tối thiểu

```json
{
  "video_id": "L21_V001",
  "original_frame_id": 385,
  "start_ms": 12000,
  "end_ms": 18000,
  "preview_uri": "r2://media/keyframes/L21_V001/385.jpg",
  "evidence_ids": ["ocr-1", "caption-1"],
  "matched_modalities": ["ocr", "caption"]
}
```

## Việc còn thiếu

- Kết nối branch với index thật sau khi refined artifacts đạt import-ready.
- Chốt text encoder tương thích với image embedding checkpoint.
- Bổ sung benchmark Recall@K/MRR, duplicate rate và latency p50/p95.
- Kiểm tra anchor ASR → frame trên full dataset.
