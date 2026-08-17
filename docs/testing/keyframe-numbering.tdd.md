# Keyframe numbering in Video Studio — TDD evidence

## User journey

When a video contains sparse canonical keyframes, the operator needs a small, local ordinal (`1..N`) instead of mistaking the source frame number (`original_frame_id`) for the number of available keyframes.

## Execution evidence

| Guarantee | Test or command | Result |
|---|---|---|
| Studio and timeline expose ordinal keyframes while retaining source frame IDs | `pnpm test -- VideoStudioModal.test.tsx VideoTimelineOverlay.test.tsx Workbench.test.tsx video-studio-model.test.ts` | PASS: 18 files, 80 tests |
| The ordinal/source-frame label is stable | `apps/frontend/tests/video-studio-model.test.ts` | PASS |
| Types, lint and production bundle are valid | `pnpm typecheck`, `pnpm lint`, `pnpm build` | PASS |
| Full frontend coverage remains green | `pnpm test:coverage` | PASS: 80 tests; 88.23% statements/lines, 82.40% functions, 76.90% branches |
| The live Studio renders bounded keyframe ordinals | Browser QA on `http://localhost:3000` | PASS: `L22_V002` rendered 327 filmstrip items, from `#1`/source frame `0` to `#327`/source frame `29557`; selected heading was `Keyframe 311` |

## Implementation notes

- `keyframe_no` is now the primary number in the Studio filmstrip, selected-frame panel, same-video filmstrip and timeline labels.
- `original_frame_id` remains visible as `Source frame ...` and remains the internal identity used for thumbnail URLs, selection and export/API behavior.
- No database schema or submission format was changed.
