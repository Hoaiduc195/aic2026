# Boundary frame ranking TDD evidence

## Source plan

Derived from the approved boundary upvote/downvote frame-ranking plan in the implementation conversation.

## User journeys

- As a contestant, I can upvote any result frame to move it to rank 1 immediately.
- As a contestant, I can downvote any result frame to move it to the last rank immediately.
- As a contestant, I can still move a frame one position at a time or drag it manually.
- As a VQA user, filling the queue follows the current ranked frame order without a hidden downvote marker.

## RED/GREEN evidence

| Stage | Command | Result |
|---|---|---|
| RED | `pnpm test -- workbench-model.test.ts Workbench.test.tsx` | 2 intended failures: missing `moveFrameToBoundary` and missing boundary buttons; 35 existing tests passed. |
| GREEN | `pnpm test -- workbench-model.test.ts Workbench.test.tsx vqa-queue.test.ts` | 3 files, 41 tests passed. |
| Full verification | `pnpm test` | 24 files, 114 tests passed. |
| Coverage | `pnpm test:coverage` | 87.75% statements, 76.17% branches, 81.79% functions. |
| Static/build checks | `pnpm typecheck`, `pnpm lint`, `pnpm build` | Passed. |

## Guarantees

| # | Guarantee | Test |
|---|---|---|
| 1 | Boundary reorder moves a frame to the first or last position without mutating the input array. | `tests/workbench-model.test.ts` |
| 2 | Upvote and downvote actions immediately update the visible ranked frame list. | `tests/Workbench.test.tsx` |
| 3 | Boundary actions have accessible labels and do not create a visual downvote state. | `tests/Workbench.test.tsx` |
| 4 | Existing single-step reorder and drag-and-drop behavior remains available. | `tests/Workbench.test.tsx` |
| 5 | VQA queue preserves the current ranked order and has no hidden downvote marker. | `tests/vqa-queue.test.ts` |

## Known gaps

The dedicated Playwright suite was not run for this small interaction change; the full Workbench React test covers the same user-visible reorder flow. Existing `.playwright-mcp/` artifacts and the unrelated working-tree change in `apps/frontend/src/lib/retrieval-settings.ts` were intentionally left out of the feature commit.

## Checkpoints

- `7a2aa36 test: cover boundary frame ranking actions` — RED test checkpoint.
- `bcd17b2 fix: add boundary frame ranking actions` — GREEN implementation checkpoint.
