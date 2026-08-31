# Contract Boundary

`contracts/` is the machine-checkable data boundary between preprocessing,
feature extraction, artifact publication, ingestion, the retrieval backend, and
the competition adapter. It does not contain raw video, model code, or database
migrations.

## Invariants

- `video_id` + `original_frame_id` identifies one source frame;
  zero-based `original_frame_id` is the authoritative identity for exact-frame
  results.
- A sparse occurrence is identified by `(video_id, keyframe_no)` and may be a
  `frame_alias` pointing to a canonical frame. Fusion must deduplicate by the
  canonical `(video_id, original_frame_id)`.
- Time intervals use integer milliseconds and are half-open:
  `[start_ms, end_ms)`.
- `frame_id` is an optional legacy/adapter identity and must not replace
  `original_frame_id` inside the system.
- Evidence has an `evidence_id` and producer/model provenance and is referenced
  independently by retrieval and task results.
- Canonical captions use `language: "en"`; canonical OCR uses
  `language: "vi"`.
- Every published result records the corresponding dataset, pipeline, schema,
  artifact, and index-version tuple.
- A failed retrieval branch must be represented by a normalized `branch_result`;
  a partial candidate must not be silently published as `completed`.
- TRAKE has one semantic frame per event; `event_ordinal` is contiguous and
  `original_frame_id` increases strictly.
- VQA may be `answered`, `needs_more_evidence`, or `abstained`. An unanswered
  result must not be encoded as an empty string that appears confident.

## Schema map

| Boundary | Schemas |
|---|---|
| Video and timeline | `video_manifest`, `frame`, `frame_alias`, `micro_event`, `context_window`, `event_window` |
| Retrieval and evidence | `keyframe`, `dense_candidate`, `semantic_keyframe`, `event_score`, `evidence`, `evidence_relation` |
| Artifacts and reproducibility | `processing_run`, `artifact_manifest`, `version_manifest`, `ingestion_record` |
| Query and execution | `qualification_request`, `query_plan`, `branch_result`, `search_response` |
| Task output | `textual_kis_response`, `vqa_response`, `trake_alignment`, `qualification_response` |

Each schema is in `contracts/schemas/<name>/schema.json`. Valid and invalid
examples are in `contracts/examples/valid_outputs/` and
`contracts/examples/invalid_outputs/`.

The three internal qualification tasks use the names `textual_kis`, `vqa`, and
`trake`. Organizer field names, IDs, and timestamps must be converted in the
competition adapter rather than added to the internal contract.

## Validation

JSON Schema uses Draft 2020-12 to validate shape and types. Invariants that
compare multiple fields are additionally checked in `semantic_validation.py`,
including:

- `end_ms > start_ms` and non-empty frame intervals;
- contiguous TRAKE event ordinals and strictly increasing frame IDs;
- an `answered` VQA result must contain a non-empty answer and evidence;
- `qualification_response` must have a result type matching the task.

Run all contract and pipeline tests from the repository root:

```powershell
python -m unittest discover -s tests -q
```

Or run the fast contract suite:

```powershell
python -m unittest `
  tests.test_keyframe_contracts `
  tests.test_qualification_contracts -v
```

When changing a required field, identifier, timestamp unit, or record meaning,
read the [compatibility policy](versioning/compatibility_policy.md), update the
fixtures, and add a regression test. This README explains the contract; the JSON
Schemas and semantic validator are the source of truth.
