# Retrieval near-frame window: 100 seconds

## User journey

As a user, I want to set the near-frame filtering window up to 100 seconds, so that retrieval can group frames across longer intervals without the API rejecting the request.

## TDD evidence

| Stage | Command | Result |
|---|---|---|
| RED | `pnpm test -- retrieval-settings.test.ts search-route.test.ts` | Failed as expected: `100000ms` was rejected by the API and values above the old frontend limit were accepted. |
| GREEN | `pnpm test -- retrieval-settings.test.ts search-route.test.ts` | 2 files, 13 tests passed. |
| Full suite | `pnpm test` | 24 files, 116 tests passed. |
| Coverage | `pnpm test:coverage` | 88.6% statements, 76.23% branches, 83.28% functions. |
| Static checks | `pnpm lint`, `pnpm typecheck`, `pnpm build` | All passed. |

## Guarantees

- `near_frame_window_ms: 100000` is accepted by both the frontend validator and `/api/v1/search`.
- `near_frame_window_ms: 100001` is rejected.
- The sidebar input exposes the same `100000ms` limit.
- Frontend and API share `MAX_NEAR_FRAME_WINDOW_MS`, preventing the previous limit mismatch.

## Checkpoint commits

- RED: `6c78d79 test: cover 100-second retrieval window`
- GREEN: recorded in the implementation commit for this task.
