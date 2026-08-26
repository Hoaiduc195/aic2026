# Contract boundary

`contracts/` là ranh giới dữ liệu machine-checkable giữa preprocessing, feature
extraction, artifact publication, ingestion, retrieval backend và competition
adapter. Đây không phải nơi chứa raw video, model code hoặc migration database.

## Quy tắc bất biến

- `video_id` + `original_frame_id` xác định một source frame; `original_frame_id`
  zero-based là identity authoritative cho kết quả exact frame.
- Một lần xuất hiện sparse được xác định bởi `(video_id, keyframe_no)` và có
  thể là `frame_alias` trỏ tới canonical frame. Fusion phải loại duplicate theo
  canonical `(video_id, original_frame_id)`.
- Khoảng thời gian dùng số nguyên milliseconds và nửa mở: `[start_ms, end_ms)`.
- `frame_id` là identity legacy/adapter tùy chọn, không được thay thế
  `original_frame_id` bên trong hệ thống.
- Evidence có `evidence_id`, producer/model provenance và được tham chiếu độc
  lập bởi kết quả retrieval/task.
- Caption canonical dùng `language: "en"`; OCR canonical dùng
  `language: "vi"`.
- Mỗi kết quả đã publish phải ghi rõ tuple dataset, pipeline, schema, artifact
  và index version tương ứng.
- Retrieval branch lỗi phải được biểu diễn bằng `branch_result` chuẩn hóa;
  không được âm thầm publish candidate một phần như `completed`.
- TRAKE có một semantic frame cho mỗi event; `event_ordinal` liên tục và
  `original_frame_id` tăng nghiêm ngặt.
- VQA có thể là `answered`, `needs_more_evidence` hoặc `abstained`. Không mã
  hóa việc chưa trả lời thành chuỗi rỗng có vẻ tự tin.

## Bản đồ schema

| Boundary | Schema |
|---|---|
| Video và timeline | `video_manifest`, `frame`, `frame_alias`, `micro_event`, `context_window`, `event_window` |
| Retrieval và evidence | `keyframe`, `dense_candidate`, `semantic_keyframe`, `event_score`, `evidence`, `evidence_relation` |
| Artifact và reproducibility | `processing_run`, `artifact_manifest`, `version_manifest`, `ingestion_record` |
| Query và execution | `qualification_request`, `query_plan`, `branch_result`, `search_response` |
| Task output | `textual_kis_response`, `vqa_response`, `trake_alignment`, `qualification_response` |

Mỗi schema nằm ở `contracts/schemas/<name>/schema.json`. Ví dụ hợp lệ và không
hợp lệ nằm ở `contracts/examples/valid_outputs/` và
`contracts/examples/invalid_outputs/`.

Ba task vòng sơ tuyển nội bộ dùng tên `textual_kis`, `vqa` và `trake`. Tên
field/ID/timestamp của organizer phải được chuyển đổi ở competition adapter,
không làm bẩn contract nội bộ.

## Validation

JSON Schema dùng Draft 2020-12 để kiểm tra shape và type. Các invariant cần so
sánh nhiều field được kiểm tra thêm ở `semantic_validation.py`, ví dụ:

- `end_ms > start_ms` và frame interval không rỗng;
- TRAKE event ordinal liên tục, frame ID tăng nghiêm ngặt;
- VQA `answered` phải có answer không rỗng và evidence;
- `qualification_response` phải khớp result type với task.

Chạy toàn bộ contract/pipeline test từ repository root:

```powershell
python -m unittest discover -s tests -q
```

Hoặc chạy nhóm contract nhanh:

```powershell
python -m unittest `
  tests.test_keyframe_contracts `
  tests.test_qualification_contracts -v
```

Khi thay đổi required field, identifier, timestamp unit hoặc meaning của một
record, đọc [compatibility policy](versioning/compatibility_policy.md), cập
nhật fixture và thêm regression test. README chỉ giải thích contract; schema
JSON và semantic validator mới là nguồn sự thật.
