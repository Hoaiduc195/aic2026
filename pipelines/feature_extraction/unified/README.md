# Unified feature extraction trên Modal

Pipeline này xử lý một keyframe một lần trên một Modal GPU và tạo đồng thời
bốn feature. Nó giảm số lần cold-start so với chạy từng script riêng.

## Bốn feature

| Feature | Model mặc định | Output |
|---|---|---|
| Caption tiếng Anh | Florence-2-base | `captioning/<video>/<frame>.txt` |
| Visual embedding | CLIPA ViT-H/14, 1024 chiều | `embeddings/<video>/<frame>.npy` |
| Object detection | YOLO26n, COCO | `object_detection/<video>/<frame>.json` |
| Vietnamese OCR | PaddleOCR PP-OCRv6 | `ocr/<video>/<frame>.jsonl` |

ASR không nằm trong pipeline vì ASR đọc audio track của video gốc, không đọc
ảnh keyframe. Chạy riêng tại [`../asr/`](../asr/README.md).

## Cài đặt và quick start

Máy local chỉ cần Modal CLI:

```powershell
python -m pip install -r pipelines/feature_extraction/unified/requirements-modal.txt
modal token new
```

Chạy partition đầu tiên:

```powershell
modal run pipelines/feature_extraction/unified/modal_unified_pipeline.py `
  --keyframe-dir E:\aic2026\keyframes `
  --data-root E:\aic2026\data `
  --batch-index 0 --num-batches 3 --budget-usd 25
```

Ba worker có thể dùng index `0`, `1`, `2`. Không cho hai worker ghi cùng
partition hoặc cùng output folder.

Dry-run để đếm frame pending và ước tính chi phí mà không upload:

```powershell
modal run pipelines/feature_extraction/unified/modal_unified_pipeline.py `
  --keyframe-dir E:\aic2026\keyframes `
  --data-root E:\aic2026\data `
  --dry-run
```

## Resume và output

Một frame chỉ được xem là hoàn tất khi **cả bốn file output** tồn tại. File
được ghi atomic; frame partial sẽ được xử lý lại ở lần chạy tiếp theo. Dùng
`--overwrite` để chủ động chạy lại tất cả frame trong partition.

```text
<data-root>/
├── captioning/<video>/<frame>.txt
├── embeddings/<video>/<frame>.npy
├── object_detection/<video>/<frame>.json
└── ocr/<video>/<frame>.jsonl
```

Input hỗ trợ `.jpg`, `.jpeg`, `.png`, `.webp`, `.bmp` đệ quy. `--max-images`
giới hạn số frame pending (`0` = không giới hạn), `--batch-size` là số frame
trong một submission window local, và `--max-retries` kiểm soát retry lỗi
transient.

## GPU, model và flag

Mặc định dùng L4 16 GB. Đổi GPU hoặc model YOLO trước khi chạy:

```powershell
$env:UNIFIED_GPU = "A10G"
$env:UNIFIED_YOLO_MODEL = "yolo26s.pt"
modal run pipelines/feature_extraction/unified/modal_unified_pipeline.py `
  --keyframe-dir E:\aic2026\keyframes `
  --data-root E:\aic2026\data
```

Các flag chính:

| Flag | Mặc định | Ý nghĩa |
|---|---:|---|
| `--keyframe-dir` | `keyframes` | Root ảnh input |
| `--data-root` | `data` | Root bốn output |
| `--batch-index` | `0` | Partition hiện tại |
| `--num-batches` | `1` | Tổng partition |
| `--batch-size` | `8` | Frame/submission window |
| `--max-retries` | `2` | Retry mỗi chunk |
| `--budget-usd` | `25` | Cost guardrail |
| `--max-images` | `0` | Giới hạn frame; 0 = unlimited |
| `--overwrite` | tắt | Bỏ qua resume và chạy lại |
| `--dry-run` | tắt | Chỉ lập kế hoạch |

Model names, threshold và output version tập trung ở
`unified/config.py`. Nếu đổi model/projection/normalization, cập nhật metadata
contract và downstream importer tương ứng.

## Khi nào dùng pipeline riêng?

Unified phù hợp khi cùng một tập keyframe cần cả bốn feature và muốn giảm
cold-start. Chạy script riêng khi chỉ cần một modality, cần retry độc lập hoặc
muốn chọn cấu hình GPU/model khác cho từng modality.

## Kiểm tra

```powershell
python -m unittest discover -s tests -q
```

Các utility test không cần Modal GPU; nên luôn chạy dry-run và một pilot nhỏ
trước full dataset.
