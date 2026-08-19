# Retrieval persistence and 100-second near-frame window

## User journeys

- As a user, I want a frame-similarity query to be persisted without violating the database query-text constraint, so that its candidates remain available for manual selection.
- As a user, I want to configure near-frame filtering up to 100 seconds, so that the backend applies the same limit accepted by the frontend.

## TDD evidence

| Stage | Command | Result |
|---|---|---|
| RED | `pnpm test -- request-validation.test.ts query-planner.test.ts retrieval-store.test.ts` | Failed as expected: backend rejected `100000ms`, planner clamped it to `10000ms`, and frame persistence stored an empty query text. |
| GREEN | `pnpm test -- request-validation.test.ts query-planner.test.ts retrieval-store.test.ts` | 3 files, 18 tests passed. |
| Full suite | `pnpm test` | 32 files, 126 tests passed. |
| Coverage | `pnpm test:coverage` | 84.86% statements, 74.85% branches, 93.65% functions. |
| Static checks | `pnpm typecheck`, `pnpm build` | Both passed. |

## Guarantees

- Frame-only retrievals persist a non-empty label containing the video and source frame.
- Text retrievals continue to persist their original query text.
- Backend validation accepts `near_frame_window_ms` through `100000` and rejects `100001`.
- Query planning preserves the configured `100000ms` window instead of clamping it to `10000ms`.
- The frame-query label and retrieval limit are centralized in backend constants.

## Checkpoint commits

- RED: `99556d9 test: cover frame persistence and 100-second window`
- GREEN: recorded in the implementation commit for this task.
