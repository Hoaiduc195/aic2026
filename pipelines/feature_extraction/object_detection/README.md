# Object detection bằng YOLO trên Modal

`modal_yolo.py` quét thư mục frame local, gửi upload window có giới hạn tới
Ultralytics YOLO trên Modal GPU và ghi một JSON result cho mỗi ảnh. PyTorch,
detector và model weights không chạy trên máy local.

## Mặc định

| Thuộc tính | Giá trị |
|---|---|
| Model | `yolo26n.pt`, pretrained COCO |
| Ultralytics | headless `8.4.104` |
| GPU | T4 |
| Input | `.jpg`, `.jpeg`, `.png`, `.webp`, `.bmp` đệ quy |
| Output | JSON theo đúng layout input |

Mỗi detection có class ID/name, confidence, pixel box `bbox_xyxy` và box chuẩn
hóa `bbox_normalized`. Frame không có object vẫn ghi record thành công với
`detections: []`.

Ultralytics model distribution dùng license AGPL-3.0. Kiểm tra nghĩa vụ license
trước khi đưa pipeline vào sản phẩm thương mại.

## Cài đặt

```powershell
python -m pip install -r pipelines/feature_extraction/object_detection/requirements-modal.txt
modal token new
```

Runtime headless, PyTorch, Pillow và weights được cài trong Modal image.
Weights giữ trong volume `aic-ultralytics-model-cache`; bản OpenCV headless
tránh dependency GUI như `libGL`.

## Chạy pilot

`--dry-run` chỉ in kế hoạch, không khởi tạo Modal và không ghi output:

```powershell
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection `
  --max-images 500 --dry-run
```

Chạy sample thật:

```powershell
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection `
  --max-images 500
```

Bỏ `--max-images` để xử lý toàn bộ dataset:

```powershell
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection `
  --batch-size 64
```

Output đã hoàn tất được resume tự động. Dùng `--overwrite` để tính lại.

## Sharding và tuning

Chia input deterministic cho nhiều worker:

```powershell
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection `
  --batch-index 0 --num-batches 4 --batch-size 64
```

Chạy lại với index `1`, `2`, `3`. Mỗi partition có manifest và error log riêng;
không cho hai worker ghi cùng partition.

Mặc định dùng T4. Chọn L4 hoặc model lớn hơn khi ưu tiên throughput/accuracy:

```powershell
$env:OBJECT_DETECTION_MODAL_GPU = "L4"
$env:OBJECT_DETECTION_MODEL = "yolo26s.pt"
modal run pipelines/feature_extraction/object_detection/modal_yolo.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\object_detection
```

Các flag `--image-size`, `--confidence-threshold`, `--iou-threshold` và
`--max-detections` điều chỉnh trade-off accuracy/thời gian/bộ nhớ.

## Output

Với input `L21_V001/001.jpg`, output là `L21_V001/001.json`:

```json
{
  "relative_path": "L21_V001/001.jpg",
  "model": "yolo26n.pt",
  "image_width": 1920,
  "image_height": 1080,
  "num_detections": 1,
  "detections": [
    {
      "class_id": 0,
      "class_name": "person",
      "confidence": 0.91,
      "bbox_xyxy": [100.0, 80.0, 420.0, 900.0],
      "bbox_normalized": [0.052, 0.074, 0.219, 0.833]
    }
  ]
}
```

`run_batch_*.jsonl` ghi frame hoàn tất; `errors_batch_*.jsonl` ghi lỗi đọc local
hoặc inference remote. Cả hai là log append-only để audit/retry shard.

## Kiểm tra

```powershell
python -m unittest tests.test_object_detection_modal -v
```

Test dùng fake Modal response nên không cần credential, Ultralytics hoặc GPU.
