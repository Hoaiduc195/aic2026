# Keyframe numbering in the ranked result list — TDD evidence

## User journey

When an object search returns a sparse set of canonical keyframes, the result list must show the canonical ordinal (`keyframe_no`) instead of making the source video frame (`original_frame_id`) look like the keyframe number. The source frame remains available for media lookup and submission/export behavior.

## Execution evidence

| Guarantee | Test or command | Result |
|---|---|---|
| Backend retrieval branches expose `keyframe_no` | `cd apps/backend; pnpm.cmd test -- postgres-retrieval.test.ts` | RED: 2 candidate-mapping assertions failed; GREEN: 24 files, 79 tests passed |
| Frontend normalizes and renders the ordinal/source-frame label | `cd apps/frontend; pnpm.cmd test -- workbench-model.test.ts Workbench.test.tsx` | RED: 2 assertions failed; GREEN: 18 files, 81 tests passed |
| Backend typecheck and production build are valid | `pnpm.cmd typecheck`, `pnpm.cmd build` | PASS |
| Frontend typecheck, lint and production build are valid | `pnpm.cmd typecheck`, `pnpm.cmd lint`, `pnpm.cmd build` | PASS |
| Full backend coverage remains green | `cd apps/backend; pnpm.cmd test:coverage` | PASS: 79 tests; 88.52% statements/lines, 95.93% functions, 77.18% branches |
| Full frontend coverage remains green | `cd apps/frontend; pnpm.cmd test:coverage` | PASS: 81 tests; 88.29% statements/lines, 82.60% functions, 77.08% branches |
| Live object results display canonical ordinals | Browser QA on `http://localhost:3000` with query `person` | PASS: result cards showed labels such as `Keyframe 311 · Source frame 28062` and accessible labels such as `Chọn keyframe L22_V002 · 311 · source frame 28062` |

## Implementation notes

- PostgreSQL caption, object and CLIP branches now select `frames.keyframe_no` and carry it through fusion, variant merging and `SearchResult.representative_frame`.
- The frontend displays `Keyframe N · Source frame X` when the metadata exists and keeps the old `Frame X` fallback for older responses.
- `original_frame_id` remains the authoritative source-frame identity for thumbnails, media access, selection and submission/export payloads.
- The response and branch-result schemas accept the new optional field; no submission format or database key was changed.

