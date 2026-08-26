# Timeline-only ASR

Module này chuyển một audio/video stream thành các đoạn speech có timestamp,
giữ interval nửa mở `[start_ms, end_ms)`. ASR không chiếu transcript lên shot
boundary hoặc keyframe trung gian; retrieval có thể dùng timeline để neo sang
frame gần đó.

## Output contract

Mỗi row canonical gồm:

- `video_id`, `start_ms`, `end_ms`;
- `text_raw`, `text_normalized`, `language`, `confidence`;
- `producer`, `model_version`, `pipeline_version` và metadata quality tùy chọn;
- word timing/no-speech probability nếu backend cung cấp.

CLI ghi JSONL canonical cho từng input; Parquet/JSON cũng có thể tạo qua legacy
adapter. Refined ingestion dùng artifact `asr_spans.parquet` và kiểm tra shape
theo [`contracts/schemas/asr_span/schema.json`](../../../contracts/schemas/asr_span/schema.json).

## Cài đặt

Headless Sherpa runtime:

```powershell
python -m pip install -r pipelines/feature_extraction/asr/requirements-sherpa.txt
```

Model Sherpa và FFmpeg là dependency bên ngoài repository. Cấu hình mặc định
nằm ở [`config.ini`](config.ini), gồm model name, tiếng Việt, CPU provider,
punctuation và quality processing.

## CLI Sherpa

Kiểm tra runtime/model trước:

```powershell
python -m pipelines.feature_extraction.asr.cli check
```

Transcribe một file:

```powershell
python -m pipelines.feature_extraction.asr.cli transcribe `
  input.wav --output data/asr/video_1.asr.jsonl
```

Transcribe cả thư mục; thêm `--recursive` nếu media nằm trong thư mục con:

```powershell
python -m pipelines.feature_extraction.asr.cli batch `
  data/audio --output-dir data/asr --recursive
```

Output đã tồn tại sẽ được bỏ qua. Dùng `--overwrite` khi muốn chạy lại. Các
tham số `--model-dir`, `--model-name`, `--language`, `--device`, `--cpu-threads`,
`--ffmpeg-dir`, `--disable-punctuation` và `--disable-quality` có thể override
config; xem `--help` để biết đầy đủ.

## Adapter transcript/Whisper

Legacy adapter hữu ích để chuyển transcript JSON deterministically mà không cần
model ASR:

```powershell
python -m pipelines.feature_extraction.asr.cli `
  --video-id video_1 `
  --output data/asr/video_1.jsonl `
  --backend transcript-json `
  --transcript-json data/transcripts/video_1.json
```

Input chunk có dạng:

```json
[
  {"start": 0.0, "end": 1.25, "text": "xin chao"}
]
```

Các backend `faster-whisper` và `openai-whisper` cũng có thể dùng qua legacy
flags. CLI chuẩn hóa timestamp sang milliseconds và NFC-normalize text; không
cần shot map, frame grouping hay timeline input phụ.

## Kiểm tra

```powershell
python -m unittest tests.test_asr_module tests.test_sherpa_asr_cli -v
```

Nếu output dùng cho ingestion, kiểm tra thêm language, interval nằm trong
duration video và `video_id` khớp canonical manifest trước khi import.
