# Greenfield multimodal pipeline

`pipelines/main` là orchestration DAG mới cho một hoặc nhiều video. Package này
có registry/node/checkpoint/artifact store riêng và **không import** pipeline
legacy ở `pipelines/preprocessing` hoặc `pipelines/feature_extraction`.

Các JSON Schema canonical vẫn lấy từ repository-level
[`contracts/`](../../contracts/README.md) và được validate ở boundary của node.

## Task mặc định

```text
ingestion -> frame_manifest -> shot_detection -> keyframes
          -> visual_embedding, asr, ocr, object_detection, captioning
          -> normalization
```

Dependency closure được tự động thêm khi chọn một task. Một node thiếu optional
model dependency sẽ trả lỗi rõ ràng và run có thể ở trạng thái `partial`; hệ
thống không tạo feature row giả để che lỗi.

## Profile

| Profile | Cách chạy |
|---|---|
| `local` | Tất cả node dùng local provider |
| `hybrid` | Timeline/keyframe core chạy local, task model có thể chạy Modal |
| `modal` | Các node được cấu hình chạy qua Modal dispatcher |

Mặc định là `local`. Cấu hình mẫu nằm ở
[`pipeline.example.toml`](pipeline.example.toml), gồm pipeline/schema version,
dataset identity, task list và options của từng node.

## Cài đặt

### Local

Yêu cầu Python `3.11+`:

```powershell
python -m pip install -r pipelines/main/requirements-local.txt
```

### Modal

```powershell
python -m pip install -r pipelines/main/requirements-modal.txt
modal token new
```

Node Modal nhận task name, source identity, config và artifact manifest. Cache
content-addressed trong `storage/modal_cache.py` được dùng để tránh stage lại
artifact không đổi.

## CLI

Từ repository root, plan trước khi run:

```powershell
python -m pipelines.main plan `
  --input data/video.mp4 --profile local

python -m pipelines.main run `
  --input data/video.mp4 `
  --output-dir outputs `
  --profile local
```

Có thể truyền nhiều `--input`, hoặc một directory với `--input-dir`; thêm
`--recursive` để quét thư mục con. `--tasks` cho phép chạy subset, nhưng các
dependency cần thiết vẫn được thêm vào DAG.

Quản lý run:

```powershell
python -m pipelines.main status `
  --output-dir outputs --run-id RUN_ID

python -m pipelines.main resume `
  --output-dir outputs --run-id RUN_ID

python -m pipelines.main retry `
  --output-dir outputs --run-id RUN_ID --failed-only
```

`run` trả exit code thành công cho trạng thái `completed` hoặc `partial`.
`status` đọc run record mà không chạy lại pipeline.

## Output và resume

Mỗi run được namespaced dưới:

```text
outputs/runs/<run_id>/
├── run.json
├── checkpoints/<video_id>/<task>.json
├── processing_runs/<video_id>/<task>.json
└── artifacts/
```

Checkpoint chứa fingerprint của input/config/node. Chỉ checkpoint `completed`
và fingerprint trùng mới được reuse; thay đổi input hoặc cấu hình sẽ chạy lại
node đó. Processing run ghi dataset/pipeline/schema version, input/output
artifact IDs, metrics và error để audit.

## Ranh giới với pipeline legacy

Dùng package này khi cần một DAG orchestrator có profile, retry/resume và
artifact contract thống nhất. Dùng
[`pipelines/preprocessing/README.md`](../preprocessing/README.md) cho keyframe
pipeline hai tầng hiện hữu và các lệnh sparse/dense cụ thể. Dùng các README
feature extraction tương ứng khi chạy worker độc lập trên Modal.

## Kiểm tra

```powershell
python -m unittest discover -s pipelines/main/tests -v
```

Thay đổi node contract phải cập nhật validator, fixture và test trong cùng
commit; không bỏ qua trạng thái `partial` bằng cách ghi output placeholder.
