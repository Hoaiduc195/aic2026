# Video preprocessing và keyframe

Module này xây nền tảng frame-first cho retrieval video. Nó không phải một
solver hoàn chỉnh cho Textual KIS, VQA hoặc TRAKE; query-specific event model,
OCR/ASR reasoning và multi-event ordering nằm ở các module downstream.

## Hai tầng xử lý

```text
video gốc
  -> probe + canonical frame manifest
  -> shot detection và sparse retrieval frames
  -> embedding/index để tìm vùng ứng viên
  -> event window
  -> dense decode theo original FPS
  -> semantic keyframe exact
```

### Tầng 1: sparse retrieval

Mỗi video được decode tuần tự để tạo manifest đầy đủ. Sparse sampler kết hợp:

- shot start/end và anchor theo thời lượng;
- peak scene change, motion và text-region change;
- quality score (brightness, blur, contrast, entropy);
- dHash và tùy chọn SigLIP cosine deduplication;
- tùy chọn DINOv2 để deduplicate hoặc tạo cluster medoid.

Quality chỉ quyết định route retrieval (`retrieval_embedding` hoặc
`temporal_only`), không xóa frame khỏi timeline. Coverage repair chỉ thêm
candidate đủ quality; dense stage không quality-filter hoặc deduplicate vì một
frame chuyển cảnh mờ vẫn có thể là đáp án chính xác.

### Tầng 2: dense exact-frame alignment

Hit sparse được mở rộng thành event window nửa mở `[start_frame_id,
end_frame_id)`. Workflow mở lại video bất biến, seek về codec keyframe, decode
từng source frame, ghép PTS với manifest và chọn đúng một semantic frame.
Selector ghi component score để quyết định có thể audit; event score bên ngoài
được ưu tiên hơn quality, motion và target-frame hint.

## Canonical frame identity

`original_frame_id` là số nguyên zero-based được gán khi decode từ đầu video:

```text
frame đầu tiên  -> 0
frame thứ hai   -> 1
...
```

Manifest lưu PTS, time base, FPS phân số, timestamp, codec-keyframe flag,
quality và change signal cho mọi frame. `raw_pts_timestamp_ms` giữ PTS gốc;
`timestamp_ms` là timeline đã chuẩn hóa về origin, finite, không âm và không
giảm. Không được làm tròn timestamp để tạo lại frame ID khi đã có identity.

Dense decode fail-closed: nếu seek không phục hồi đủ range yêu cầu, workflow
retry từ đầu stream; nếu vẫn thiếu frame thì báo lỗi thay vì trả range lệch hoặc
partial.

## Cài đặt

Yêu cầu Python `3.11+`. Bản local không cài torch/FAISS để giữ smoke test nhẹ:

```powershell
python -m pip install -r pipelines/preprocessing/requirements-local.txt
```

`ffmpeg`/`ffprobe` phải có trong `PATH` khi probe video hoặc chạy ASR. Lane
DINOv2 cần thêm `torch` và `timm`; Kaggle requirements đã bao gồm `timm`.

## Chạy local

Từ repository root:

```powershell
python -m pipelines.preprocessing.cli probe `
  --input-glob "data/**/*.mp4" --out outputs

python -m pipelines.preprocessing.cli frames --out outputs
python -m pipelines.preprocessing.cli shots `
  --out outputs --device cpu --no-sbd-download
python -m pipelines.preprocessing.cli extract `
  --out outputs --device cpu --no-embed
python -m pipelines.preprocessing.cli index --out outputs --device cuda
```

`--no-embed` phù hợp cho CPU smoke test; FAISS index cần embedding nên run
production thường dùng CUDA và bỏ flag này. Các stage có checkpoint theo video,
ghi qua temporary file rồi replace atomic. Table đọc được nhưng không đủ cấu
trúc sẽ bị rebuild thay vì resume mù.

Lệnh `all` chọn manifest theo thứ tự:

1. `--manifest FILE` nếu truyền vào;
2. `--source-uri` hoặc `--source-uri-file` để probe nguồn explicit;
3. `outputs/videos_manifest.parquet` hiện có;
4. `--input-glob` để tạo manifest mới.

Ví dụ:

```powershell
# Reuse manifest và checkpoint hợp lệ.
python -m pipelines.preprocessing.cli all --out outputs

# Chủ động probe lại glob.
python -m pipelines.preprocessing.cli all --out outputs --reprobe `
  --input-glob "data/**/*.mp4"

# Manifest curated luôn được ưu tiên.
python -m pipelines.preprocessing.cli all --out outputs `
  --manifest manifests/r2_videos.parquet
```

`--reprobe` chỉ áp dụng cho `all`; dùng `probe` nếu chỉ muốn rebuild video
manifest. Standalone `frames`, `shots`, `extract` và `dense` cũng nhận
`--manifest` hoặc source URI explicit.

## Event window và dense stage

Sau khi có retrieval hits dạng Parquet:

```powershell
python -m pipelines.preprocessing.cli windows `
  --out outputs --hits outputs/query_hits.parquet --run-id query_001

python -m pipelines.preprocessing.cli dense `
  --out outputs `
  --windows outputs/event_windows/query_001.parquet `
  --device cpu
```

Decode một window thủ công:

```powershell
python -m pipelines.preprocessing.cli dense `
  --out outputs --video-id L01_V001 `
  --start-frame 140 --end-frame 156 `
  --event-window-id manual_001 --target-frame 148
```

`--end-frame` là exclusive. Event scores phải finite, được key bởi
`original_frame_id` và phải phủ đúng từng frame trong window. Batch nhiều
window bắt buộc có thêm `video_id` và `event_window_id`; positional array bị
từ chối. `run_id` nên path-safe và khác nhau cho từng retrieval run.

Checkpoint dense được fingerprint theo window, resize, target hint, event
score, frame manifest, source identity và selector version. Dùng `dense --force`
để rebuild có chủ ý.

## Local, R2 và S3

Raw video phải còn truy cập được vì dense stage mở lại video theo nhu cầu.
Manifest chấp nhận local path, `file://`, `r2://` và `s3://`:

```text
D:/datasets/L01_V001.mp4
file:///D:/datasets/L01_V001.mp4
r2://bucket/raw/L01_V001.mp4
s3://bucket/raw/L01_V001.mp4
```

R2/S3 dùng seekable byte-range reader. Trước khi đọc, reader yêu cầu
`ContentLength` và `VersionId` hoặc `ETag`; mọi range request sau đó pin vào
identity này. Nếu object bị thay tại cùng key, phải refresh manifest/checkpoint.

Có thể bridge credential từ file `.env` của R2 console mà không tự động load
file đó:

```powershell
python -m pipelines.preprocessing.cli all `
  --source-uri r2://my-bucket/raw/L01_V001.mp4 `
  --out outputs --env-file ../r2_console/.env `
  --device cpu --no-embed --no-sbd-download
```

Hoặc dùng `--source-uri-file` với mỗi URI trên một dòng và standard AWS
credential environment. Credential không được đặt trong URI hoặc secret CLI
flag. Khi output sẽ upload object storage, truyền prefix ổn định:

```powershell
python -m pipelines.preprocessing.cli all `
  --source-uri-file sources.txt `
  --out outputs --artifact-uri-prefix r2://bucket/aic-run
```

Pipeline không upload raw video và không tự đặt retention policy. Runbook
Kaggle/R2 đầy đủ ở [`docs/keyframe_kaggle_r2_runbook.md`](../../docs/keyframe_kaggle_r2_runbook.md).

## Output layout

```text
outputs/
├── videos_manifest.parquet
├── frame_manifests/{video_id}.parquet
├── shots/{video_id}.parquet
├── retrieval_candidates/{video_id}.parquet
├── retrieval_frames/{video_id}.parquet
├── keyframes/{video_id}/{n}.webp
├── map-keyframes/{video_id}.csv
├── features/{video_id}.npy
├── metadata/{video_id}.json
├── event_windows/{run_id}.parquet
├── dense_candidates/{event_window_id}.parquet
├── semantic_keyframes/{event_window_id}.json
└── index/
    ├── keyframes.faiss
    └── keyframes_index.parquet
```

`retrieval_candidates` giữ mọi candidate và route; `retrieval_frames` chỉ giữ
frame đủ điều kiện embedding sau retrieval-only dedup. `dense_candidates` giữ
metadata/evidence của mọi frame decode, còn RGB chỉ sống tạm trong memory.
`semantic_keyframes` ghi frame exact đã chọn và selector evidence.

## Ranh giới module

Đã có: canonical manifest, sparse sampling, quality routing, dedup/coverage
repair, tùy chọn DINO, embedding/index input, event windows, dense decode,
semantic selector và local/S3-compatible source reader.

Chưa phải trách nhiệm của package này: learned event scorer, OCR recognition,
ASR transcription, multimodal fusion, tracking/pose/object state, Textual
KIS/VQA handlers và TRAKE sequence parser.

## Kiểm tra

```powershell
python -m unittest discover -s tests -q
```

Khi thay đổi frame identity, output hoặc checkpoint fingerprint, cập nhật
schema trong [`contracts/`](../../contracts/README.md) và thêm regression test.
