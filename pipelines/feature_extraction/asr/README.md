# Timeline-only ASR pipeline

This package transcribes one audio stream per video and publishes spoken-text
evidence as half-open timeline intervals `[start_ms, end_ms)`. ASR is not
projected onto shot boundaries or another intermediate grouping. Retrieval can
anchor an interval to a nearby source frame when it needs a visual result.

## Outputs

Canonical rows contain:

- `video_id`
- `start_ms`, `end_ms`
- `text_raw`, `text_normalized`, `language`
- `producer`, `model_version`, `pipeline_version`, `schema_version`
- optional word timing and quality metadata

The normalized offline dataset is written as `asr_spans.jsonl` and
`asr_spans.parquet`, with a manifest and quality report beside them. The shape
is validated against `contracts/schemas/asr_span/schema.json`.

## Headless Sherpa CLI

```powershell
python -m pipelines.feature_extraction.asr.cli check
python -m pipelines.feature_extraction.asr.cli transcribe input.wav --output output.asr.jsonl
python -m pipelines.feature_extraction.asr.cli batch data/audio --output-dir data/asr --recursive
```

Use `--model-dir`, `--model-name`, `--language`, `--device`, and the other
runtime options shown by `--help` to override configuration.

## Transcript adapters

The JSON and Whisper adapters accept their provider-native chunk lists and
convert timestamps to integer milliseconds. The provider field name remains at
that external boundary; it is not copied into the canonical schema or database
identity.

For a JSON transcript:

```json
[
  {"start": 0.0, "end": 1.25, "text": "xin chao"}
]
```

The direct transcript CLI is useful for deterministic local conversion:

```powershell
python -m pipelines.feature_extraction.asr.cli `
  --video-id video_1 `
  --output data/asr/video_1.jsonl `
  --backend transcript-json `
  --transcript-json data/transcripts/video_1.json
```

No shot map, frame grouping, or additional timeline input is required.
