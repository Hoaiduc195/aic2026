# Visual embedding bằng CLIPA-v2

Module này tạo vector visual cho retrieval-eligible keyframe bằng CLIPA-v2
Vision Encoder. Vector được lưu dạng NumPy matrix và manifest Parquet, map từng
row về `video_id` và `original_frame_id` của source frame.

Model mặc định là `hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B`; output chuẩn
là `float32`, 1024 chiều và L2-normalized để tương thích với query embedding
service/backend pgvector. Text query encoder phải dùng cùng checkpoint,
projection và normalization.

## Hai cách chạy

### Local CLI

`cli.py` nhận thư mục gồm các file `<video_id>.parquet`. Mỗi Parquet mô tả
keyframe và `storage_uri`/`path` của ảnh local:

```powershell
python -m pip install -r pipelines/requirements.txt
python -m pipelines.feature_extraction.visual_embedding.cli `
  --input-dir data/keyframe_manifests `
  --output-dir data/embeddings `
  --overwrite
```

Local CLI đọc ảnh theo batch, ghi `<video_id>.npy` và `<video_id>.parquet`.
Không truyền URI credentialed hoặc path ngoài layout được phép.

### Modal GPU

`modal_clip_embedding.py` có thể discover một `.zip`, thư mục Parquet hoặc thư
mục ảnh theo video:

```powershell
python -m pip install -r pipelines/feature_extraction/embedding/requirements-modal.txt
modal token new
modal run pipelines/feature_extraction/visual_embedding/modal_clip_embedding.py `
  --input-dir E:\aic2026\keyframes `
  --output-dir E:\aic2026\data\embeddings `
  --budget-usd 30
```

`--dry-run` chỉ scan input; `--overwrite` ghi lại output hiện có;
`--video-ids V001,V002` giới hạn video; `--submission-window` và
`--concurrency` điều chỉnh số work local đang in-flight. Modal worker mặc định
dùng A10G, batch GPU 64 và giữ model cache trong volume.

## Cấu hình local

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CLIP_MODEL_NAME` | CLIPA checkpoint ở trên | OpenCLIP model identifier |
| `CLIP_BATCH_SIZE` | `32` | Số ảnh mỗi local inference batch |
| `CLIP_DEVICE` | `cuda` nếu có, ngược lại `cpu` | Thiết bị local |

Không đổi `CLIP_MODEL_NAME` mà vẫn dùng index cũ. Khi checkpoint/projection hoặc
normalization thay đổi, phải tạo lại image index và query embedding tương ứng.

## Output contract

```text
<output-dir>/
├── <video_id>.npy       # shape (N, 1024)
└── <video_id>.parquet   # metadata theo thứ tự row của matrix
```

Manifest lưu model/pipeline version, dimension, dtype, normalization, storage
URI và source-frame identity. Ingestion sẽ fail-closed nếu matrix không khớp row
count, row index, dimension hoặc model contract.

## Kiểm tra

```powershell
python -m unittest tests.test_visual_embedding_modal tests.test_modal_clip_embedding -v
```

Test utility không cần GPU khi dùng fake Modal response. Chạy pilot nhỏ trước
khi tạo full index để kiểm tra row order và chất lượng vector.
