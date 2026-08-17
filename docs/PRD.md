# AIC 2026 Multimedia Retrieval Assistant

## Product goal

Turn long, noisy videos into timestamp-accurate evidence and help an operator
find and submit exact frames for Textual KIS, VQA and TRAKE.

## Product principles

1. Frame identity is authoritative: `(video_id, original_frame_id)`.
2. Evidence keeps its interval, producer, model and version provenance.
3. ASR is a timeline span; it is not forced into an image identity until a
   result needs a display frame.
4. Retrieval is cheap-first and branch-isolated.
5. Media URLs are signed at the backend boundary; secrets never reach the UI.
6. Manual answers are stored as immutable revisions and previewed locally.

## User flows

### Textual KIS

The operator enters a natural-language description, reviews ranked frames,
opens evidence and adds the chosen frame to the answer queue.

### VQA

The operator asks a question. The system retrieves the relevant frame and
supporting OCR/ASR/caption/object evidence; it may abstain when evidence is
insufficient.

### TRAKE

The operator supplies ordered event descriptions. The system returns an
increasing sequence of source frames from the same video.

## System boundary

```text
R2 videos/keyframes/features
          ↓
Python frame + feature pipeline
          ↓
PostgreSQL evidence/index release
          ↓
NestJS planner → independent branches → frame fusion
          ↓
Next.js workbench → manual revision → submission preview
```

## Contracts

- `video_manifest` and `frame` define source identity and timestamps.
- `keyframe`, `caption_result`, `ocr_result`, `object_result` and
  `embedding_result` attach visual evidence to exact frames.
- `asr_span` and `asr_result` carry timeline intervals.
- `branch_result` and `search_response` expose frame candidates and evidence.
- `qualification_response` contains task-specific output and confidence.

## Quality gates

- Contract validation before artifact publication.
- Exact frame/timestamp and storage URI checks at import.
- Embedding dimension, checkpoint, revision and normalization checks.
- Idempotent import with counters and resumable checkpoints.
- Unit, integration and end-to-end tests with an 80% coverage target.
- Health/degraded status for database, R2 and model dependencies.

## Open work

- Complete the canonical full-frame manifest for all videos.
- Resolve the five embedding count mismatches and verify source frame mapping.
- Record the exact embedding image/text model revisions.
- Run a small Neon import and activate one verified index release.
