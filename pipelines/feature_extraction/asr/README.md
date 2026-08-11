# ASR Feature Extraction

This module extracts spoken text from video/audio and maps timestamped ASR
chunks onto video segments. The output records conform to
`contracts/schemas/asr_result/schema.json` and are intended for downstream
multimodal search, fusion, and database ingestion.

## Responsibilities

- Extract mono 16 kHz WAV audio from a video with `ffmpeg`.
- Run ASR with Whisper-compatible backends or the GUI-free Vietnamese Sherpa
  runtime cloned from the local portable distribution.
- Load precomputed transcript JSON for tests, debugging, or checkpoint reuse.
- Map transcript chunks to segment IDs by temporal overlap.
- Write ASR results as JSONL, JSON, or Parquet.

## Headless Sherpa CLI

The Sherpa adapter has no PyQt/PWA dependency. Install only the pure-Python
core from the local distribution; model files, FFmpeg, and Python packages are
kept outside the repository:

```powershell
python scripts/install_sherpa_asr.py `
  --source E:\aic2026\sherpa-vietnamese-asr-2.6.3
python -m pip install -r pipelines/feature_extraction/asr/requirements-sherpa.txt
```

Check the external runtime and model assets:

```powershell
python -m pipelines.feature_extraction.asr.cli check `
  --model-dir E:\aic2026\sherpa-vietnamese-asr-2.6.3\models `
  --ffmpeg-dir E:\aic2026\sherpa-vietnamese-asr-2.6.3
```

Transcribe one file or a directory batch:

```powershell
python -m pipelines.feature_extraction.asr.cli transcribe input.mp4 `
  --output output\input.asr.jsonl `
  --model-dir E:\aic2026\sherpa-vietnamese-asr-2.6.3\models

python -m pipelines.feature_extraction.asr.cli batch videos `
  --output-dir artifacts\asr `
  --model-dir E:\aic2026\sherpa-vietnamese-asr-2.6.3\models `
  --recursive
```

The CLI skips an existing `<stem>.asr.jsonl` unless `--overwrite` is passed.
Each line follows `contracts/schemas/asr_result/schema.json`, including
millisecond timestamps, raw/normalized text, word confidence, and the optional
headless DNSMOS quality summary. Diarization and overlap separation are
intentionally disabled in this first CLI version.

ASR is run once per audio stream, not once per frame. The transcript is then
projected onto the segment timeline so spoken content can be retrieved at the
same granularity as visual, OCR, and caption features.

## Package Layout

```text
asr/
├── __init__.py          Public module exports
├── cli.py               Command-line entry point
├── io.py                Segment input and ASR output helpers
├── models.py            Immutable data models and validation
├── segment_mapping.py   Transcript-to-segment overlap mapping
└── transcriber.py       Audio demuxing and ASR backend integrations
```

## Data Models

`Segment` is the target video interval:

```json
{
  "video_id": "video_1",
  "segment_id": "video_1_seg_001",
  "segment_start_ms": 0,
  "segment_end_ms": 5000,
  "source": "baseline",
  "confidence": 1.0
}
```

`TranscriptChunk` is raw ASR output:

```json
{
  "start_ms": 4500,
  "end_ms": 6500,
  "text": "xin chao",
  "confidence": 0.8
}
```

`AsrResult` is the final contract-compatible row:

```json
{
  "video_id": "video_1",
  "segment_id": "video_1_seg_001",
  "asr_start_ms": 4500,
  "asr_end_ms": 5000,
  "text": "xin chao",
  "confidence": 0.8
}
```

All timestamps are integer milliseconds. Model classes validate required IDs,
timestamp ordering, non-negative timestamps, and confidence values in `[0, 1]`.
Whisper confidence is derived as `exp(avg_logprob)`. If a backend or checkpoint
does not provide confidence metadata, the conservative fallback is `0.0`.

## Segment Mapping Behavior

`map_transcripts_to_segments()` emits one ASR row for every transcript/segment
temporal overlap. If one utterance crosses a segment boundary, the text is
duplicated into each overlapping segment and timestamps are clipped to the
segment range.

Example:

```text
Transcript chunk: 4500ms -> 6500ms, "xin chao"

Segment 1: 0ms    -> 5000ms
Segment 2: 5000ms -> 10000ms
```

Output:

```text
Segment 1: 4500ms -> 5000ms, "xin chao"
Segment 2: 5000ms -> 6500ms, "xin chao"
```

Blank transcript text is skipped. Segments with a different `video_id` are
rejected to prevent cross-video contamination.

## Backends

### `faster-whisper`

Uses the `faster-whisper` package. This is the default CLI backend.

```powershell
python -m pipelines.feature_extraction.asr.cli `
  --video-id video_1 `
  --segments data/segments/video_1.json `
  --video data/raw/video_1.mp4 `
  --output data/features/asr/video_1.jsonl `
  --backend faster-whisper `
  --model-name small `
  --language vi `
  --device auto
```

### `openai-whisper`

Uses the original `whisper` package.

```powershell
python -m pipelines.feature_extraction.asr.cli `
  --video-id video_1 `
  --segments data/segments/video_1.json `
  --audio data/tmp/asr/video_1.16k_mono.wav `
  --output data/features/asr/video_1.jsonl `
  --backend openai-whisper `
  --model-name small `
  --language vi
```

### `transcript-json`

Loads precomputed transcript chunks from JSON. This is useful for tests,
debugging, and rerunning the mapper without invoking Whisper.

```powershell
python -m pipelines.feature_extraction.asr.cli `
  --video-id video_1 `
  --segments data/segments/video_1.json `
  --audio ignored.wav `
  --backend transcript-json `
  --transcript-json data/checkpoints/video_1.transcript.json `
  --output data/features/asr/video_1.jsonl
```

Transcript JSON may be either a list or an object with a `segments` list:

```json
{
  "segments": [
    {
      "start": 1.25,
      "end": 2.5,
      "text": "noi dung",
      "confidence": 0.9
    }
  ]
}
```

The transcript loader accepts either seconds fields (`start`, `end`) or
millisecond fields (`start_ms`, `end_ms`).

## CLI Options

Required:

- `--video-id`: ID assigned to the video.
- `--segments`: JSON file containing segment records.
- `--output`: Destination output file.

Audio source:

- `--audio`: Existing audio file.
- `--video`: Video file to demux into WAV.
- `--workdir`: Directory for generated WAV files when `--video` is used.

Backend:

- `--backend`: `faster-whisper`, `openai-whisper`, or `transcript-json`.
- `--transcript-json`: Required when `--backend transcript-json` is used.
- `--model-name`: Whisper model name. Defaults to `small`.
- `--language`: ASR language. Defaults to `vi`.
- `--device`: Whisper device. Defaults to `auto`.

Output:

- `--format jsonl`: newline-delimited JSON, default.
- `--format json`: JSON array.
- `--format parquet`: Parquet file, requires `pandas` and `pyarrow`.

## Python Usage

```python
from pathlib import Path

from pipelines.feature_extraction.asr import (
    JsonTranscriptBackend,
    Segment,
    map_transcripts_to_segments,
)

segments = [
    Segment("video_1", "seg_1", 0, 5000),
    Segment("video_1", "seg_2", 5000, 10000),
]

backend = JsonTranscriptBackend(Path("data/checkpoints/video_1.transcript.json"))
transcripts = backend.transcribe(Path("ignored.wav"))
results = map_transcripts_to_segments("video_1", transcripts, segments)
```

## Dependencies

Base module:

- Python standard library only for models, mapping, JSON IO, and CLI parsing.

Optional runtime dependencies:

- `ffmpeg` and `ffprobe` on `PATH` for validated video-to-WAV demuxing. Inputs
  longer than six hours are rejected by default and subprocesses use timeouts.
- `faster-whisper` for `--backend faster-whisper`.
- `openai-whisper` for `--backend openai-whisper`.
- `pandas` and `pyarrow` for Parquet output.

## Testing

Run the ASR tests from the repository root:

```powershell
python -m unittest src.tests.test_asr_module
```

The tests cover overlap mapping, timestamp clipping, blank transcript skipping,
video ID validation, JSON transcript loading, segment JSON loading, and JSONL
contract output.
