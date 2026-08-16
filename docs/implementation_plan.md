# Implementation plan — frame-first retrieval

## Phase 1: contracts and source timeline

1. Validate video metadata and produce a complete decoded-frame manifest.
2. Validate keyframe map rows against `(video_id, original_frame_id, timestamp_ms)`.
3. Publish frame/keyframe schemas and immutable artifact manifests.

## Phase 2: feature extraction

1. Normalize English captions, OCR and object detections per frame.
2. Normalize ASR as timeline spans with `start_ms/end_ms`.
3. Store embedding matrices plus model/checkpoint/revision metadata.
4. Keep empty detections and missing-source rows explicit.

## Phase 3: database and importer

1. Create `videos`, `frames`, feature/artifact, evidence and search tables.
2. Import frame identity before modality rows.
3. Validate dimensions, checksums, provenance and row counts.
4. Build search indexes after bulk import and activate one release.

## Phase 4: retrieval

1. Build deterministic query plans with frame as the only target unit.
2. Run independent visual, caption, OCR, ASR and object branches.
3. Fuse hits by frame identity with weighted RRF.
4. Persist raw internal preview URI; sign it only at the response boundary.

## Phase 5: workbench and evaluation

1. Display exact frame, evidence and neighboring frames from the source map.
2. Save manual answers as immutable revisions.
3. Measure Recall@K, MRR, evidence coverage, duplicate rate and latency.
4. Add end-to-end tests for search, playback, frame context and submission preview.

## Current gate

Backend and frontend tests are green. Refined artifacts remain staging-only
until exact frame mapping, R2 object keys, embedding revision and missing object
sources are resolved.
