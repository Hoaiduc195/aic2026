# AIC contract boundary

`contracts/` is the canonical, machine-checkable data boundary between
preprocessing, artifact publication, retrieval, task handlers, backend, and
the future competition adapter. It does not contain raw videos, model code,
database migrations, or organizer-specific submission payloads.

## Invariants

- `video_id` and `original_frame_id` identify a source frame. The latter is
  authoritative for exact-frame results.
- Internal temporal intervals use integer milliseconds and half-open semantics:
  `[start_ms, end_ms)`.
- `frame_id` is optional legacy/adapter identity and must not replace
  `original_frame_id` internally.
- Evidence is independently addressable through `evidence_id` and carries its
  producer/model provenance.
- Published results identify one coherent dataset, pipeline, schema, and index
  version tuple.
- A failed retrieval branch is represented by a normalized `branch_result` and
  cannot silently publish partial candidates as `completed`.
- TRAKE output contains one semantic frame per ordered event. JSON Schema
  validates shape; providers must additionally enforce strictly increasing
  `event_ordinal` and `original_frame_id`.
- `needs_more_evidence` and `abstained` are valid outcomes for VQA; an absent
  answer must not be encoded as a confident empty string.

## Boundary map

| Boundary | Canonical schemas |
|---|---|
| Source and temporal hierarchy | `video_manifest`, `frame`, `micro_event`, `context_window`, `event_window` |
| Retrieval and evidence | `keyframe`, `dense_candidate`, `semantic_keyframe`, `event_score`, `evidence`, `evidence_relation` |
| Reproducibility and publication | `processing_run`, `artifact_manifest`, `version_manifest`, `ingestion_record` |
| Query and branch execution | `qualification_request`, `query_plan`, `branch_result`, `search_response` |
| Preliminary-round task outputs | `textual_kis_response`, `vqa_response`, `trake_alignment`, `qualification_response` |

The three preliminary-round tasks are represented internally as
`textual_kis`, `vqa`, and `trake`. Organizer-specific names, identifiers,
timestamp units, and payloads belong behind the competition adapter.

## Validation

Every schema is Draft 2020-12 JSON Schema. Contract tests validate the schema
documents, valid fixtures, invalid fixtures, URI safety, task conditionals,
and the versioned evidence envelope. Semantic constraints that JSON Schema
cannot compare (for example `end_ms > start_ms` or strict TRAKE frame order)
must be checked by the producing/ingesting boundary as described above.

See `versioning/compatibility_policy.md` before changing a required field or
renaming an identifier.
