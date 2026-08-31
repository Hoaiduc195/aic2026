# Timeline-only ASR

This module converts an audio/video stream into timestamped speech segments
using half-open intervals `[start_ms, end_ms)`. ASR does not project the
transcript onto shot boundaries or intermediate keyframes; retrieval can use
the timeline to anchor to a nearby frame.

## Output contract

Each canonical row contains:

- `video_id`, `start_ms`, and `end_ms`;
- `text_raw`, `text_normalized`, `language`, and `confidence`;
- `producer`, `model_version`, `pipeline_version`, and optional quality
  metadata;
- word timings and no-speech probability when provided by the backend.

The CLI writes canonical JSONL for each input. Parquet/JSON can also be created
through the legacy adapter. Refined ingestion uses `asr_spans.parquet` and
validates its shape against
[`contracts/schemas/asr_span/schema.json`](../../../contracts/schemas/asr_span/schema.json).

## Installation

Headless Sherpa runtime:

```powershell
python -m pip install -r pipelines/feature_extraction/asr/requirements-sherpa.txt
```

Sherpa models and FFmpeg are external dependencies and are not included in the
repository. Default configuration is in [`config.ini`](config.ini), including
the model name, Vietnamese language, CPU provider, punctuation, and quality
processing settings.

## Sherpa CLI

Check the runtime and model first:

```powershell
python -m pipelines.feature_extraction.asr.cli check
```

Transcribe one file:

```powershell
python -m pipelines.feature_extraction.asr.cli transcribe `
  input.wav --output data/asr/video_1.asr.jsonl
```

Transcribe a directory; add `--recursive` when media is in subdirectories:

```powershell
python -m pipelines.feature_extraction.asr.cli batch `
  data/audio --output-dir data/asr --recursive
```

Existing output is skipped. Use `--overwrite` to rerun. The options
`--model-dir`, `--model-name`, `--language`, `--device`, `--cpu-threads`,
`--ffmpeg-dir`, `--disable-punctuation`, and `--disable-quality` can override
the configuration; see `--help` for the complete list.

## Transcript/Whisper adapters

The legacy adapter can deterministically convert transcript JSON without an ASR
model:

```powershell
python -m pipelines.feature_extraction.asr.cli `
  --video-id video_1 `
  --output data/asr/video_1.jsonl `
  --backend transcript-json `
  --transcript-json data/transcripts/video_1.json
```

Input chunks have this shape:

```json
[
  {"start": 0.0, "end": 1.25, "text": "xin chao"}
]
```

The `faster-whisper` and `openai-whisper` backends can also be used through the
legacy flags. The CLI normalizes timestamps to milliseconds and NFC-normalizes
text; it does not require a shot map, frame grouping, or auxiliary timeline
input.

## Verification

```powershell
python -m unittest tests.test_asr_module tests.test_sherpa_asr_cli -v
```

When output is destined for ingestion, also verify the language, that intervals
fall within the video duration, and that `video_id` matches the canonical
manifest before importing.
