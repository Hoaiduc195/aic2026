# ASR dataset normalization test record

## Contract

Each normalized row is an immutable spoken-text span:

- `video_id`
- `start_ms`, `end_ms`
- `text_raw`, `text_normalized`, `language`
- producer/model/pipeline/schema provenance

No intermediate temporal identity is generated. Source provider JSON remains
untouched; malformed rows fail closed without publishing partial artifacts.

## Covered behavior

| Case | Test |
|---|---|
| Unicode and whitespace normalization | `test_normalize_text_preserves_diacritics_and_collapses_whitespace` |
| Canonical JSONL/Parquet shape | `test_refactor_writes_canonical_span_without_confidence_or_words` |
| Manifest and quality report | `test_refactor_writes_matching_parquet_schema_and_manifest` |
| Small end overflow clipping | `test_small_end_overflow_is_clipped_and_reported` |
| Invalid interval rollback | `test_invalid_span_fails_without_leaving_partial_artifacts` |
| Explicit overwrite gate | `test_existing_output_requires_explicit_overwrite` |
