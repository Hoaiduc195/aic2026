# Hide visual embedding evidence — TDD evidence

## User journey

As a search operator, I want the frontend to show human-readable evidence such as OCR, ASR, caption, and object matches without exposing the visual embedding retrieval signal.

## TDD evidence

| Stage | Command | Result |
|---|---|---|
| RED | `pnpm test -- tests/workbench-model.test.ts tests/Workbench.test.tsx` | 2 test files, 18 tests; 2 failed because `embedding` was still rendered and the display helper did not exist. |
| GREEN | `pnpm test -- tests/workbench-model.test.ts tests/Workbench.test.tsx` | 2 test files, 18 tests passed. |
| Full suite | `pnpm test` | 15 test files, 62 tests passed. |
| Coverage | `pnpm test:coverage` | 88.66% statements/lines, 87.62% functions, 78.08% branches. |
| Static checks | `pnpm typecheck`, `pnpm lint`, `pnpm build` | All passed. |

## Guarantees

- The backend response and visual embedding retrieval path are unchanged.
- `embedding` is filtered only when formatting user-facing modality labels in the frame grid and frame inspector.
- OCR, ASR, caption, object, temporal, audio, and other visible modality labels remain available.
- A result containing only `embedding` shows a neutral dash instead of incorrectly falling back to `visual`.

## Checkpoints

- RED checkpoint: `9679d86 test: hide embedding modality from frontend evidence`
- GREEN implementation checkpoint: `4d17c56 fix: hide embedding modality from frontend evidence`
