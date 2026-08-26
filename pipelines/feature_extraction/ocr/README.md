# Vietnamese OCR trên Modal

`modal_paddleocr.py` phát hiện và nhận dạng chữ trong frame bằng PaddleOCR trên
Modal GPU. Máy local chỉ quét file, gửi batch có giới hạn và ghi JSON; detector
không chạy ở local.

## Mặc định model/runtime

- PaddleOCR `3.7.0`;
- detector `PP-OCRv6_small_det` (đổi sang `PP-OCRv6_medium_det` nếu ưu tiên
  accuracy);
- recognizer `latin_PP-OCRv5_mobile_rec` cho Latin/Vietnamese;
- PaddlePaddle `3.2.1`, CUDA 11.8, inference FP32;
- detector batch 8 frame, recognition batch tối đa 64 crop trên T4.

Model cache nằm trong Modal Volume `aic-paddleocr-model-cache` để rerun không
download lại weights.

## Input và output

Input nhận `.jpg`, `.jpeg`, `.png`, `.webp`, `.bmp` đệ quy dưới thư mục frame.
Output giữ relative layout và tạo một JSON cho mỗi frame:

```text
frames/L21_V001/001.jpg
ocr/
├── L21_V001/001.json
├── run_batch_0_of_1.jsonl
└── errors_batch_0_of_1.jsonl
```

Record chứa `relative_path`, text gốc, `normalized_text` NFC, polygon, độ tin
cậy từng box, aggregate confidence, language, model và pipeline version. Frame
không có chữ vẫn ghi record thành công với text rỗng/độ tin cậy `0`; file lỗi
đọc hoặc inference đi vào `errors_batch_*.jsonl`.

## Cài đặt

```powershell
python -m pip install -r pipelines/feature_extraction/ocr/requirements-modal.txt
modal token new
```

PaddlePaddle, PaddleOCR, Pillow và GPU runtime được cài trong Modal image.

## Pilot trước khi chạy full dataset

Dry-run chỉ discover/count, không tạo container hay output:

```powershell
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\ocr `
  --max-images 500 --dry-run
```

Chạy pilot thật, kiểm tra dấu tiếng Việt và JSON:

```powershell
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\ocr `
  --max-images 500
```

Sau đó bỏ `--max-images` để xử lý toàn bộ:

```powershell
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames `
  --output-dir E:\aic2026\ocr `
  --batch-size 64
```

`--max-images 0` là unlimited. JSON không rỗng đã có sẽ được skip; dùng
`--overwrite` để regenerate. `--batch-size` là upload window local, còn batch
GPU detector/recognizer vẫn được giới hạn riêng.

## Chia shard và chọn GPU/model

Các run độc lập dùng deterministic partition:

```powershell
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames --output-dir E:\aic2026\ocr `
  --batch-index 0 --num-batches 3
```

Chạy lại với index `1` và `2`. Không cho nhiều worker ghi cùng partition/output
đồng thời.

T4 là mặc định; chọn L4:

```powershell
$env:OCR_MODAL_GPU = "L4"
modal run pipelines/feature_extraction/ocr/modal_paddleocr.py `
  --input-dir E:\aic2026\frames --output-dir E:\aic2026\ocr
```

Đổi recognizer hoặc detector qua environment trước khi gọi Modal:

```powershell
$env:OCR_RECOGNITION_MODEL = "latin_PP-OCRv5_mobile_rec"
$env:OCR_DETECTION_MODEL = "PP-OCRv6_medium_det"
```

## Kiểm tra

```powershell
python -m unittest tests.test_ocr_modal -v
```

Test dùng fake Modal response nên không cần credential, PaddleOCR hoặc GPU.
Subtitle-heavy video có thể giảm chi phí bằng cách loại frame không đổi hoặc
crop vùng subtitle trước khi upload.
