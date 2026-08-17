# Ranked frame list drag preview — TDD evidence

## Source and journey

The implementation plan was derived from the ranked-frame workflow discussion.

As a qualification operator, I want ranked frame results rendered as a vertical thumbnail list and want neighboring items to shift while I drag a frame, so that I can curate the final ranking before exporting the top 100 results.

## Execution evidence

| Guarantee | Test or command | Result |
|---|---|---|
| The new list behavior is covered by an executable test | `pnpm test -- Workbench.test.tsx` before implementation | RED: 1 of 18 tests failed because the list and insertion preview did not exist |
| Preview ranks follow the pending insertion position | `pnpm test -- Workbench.test.tsx -t "thumbnail list"` before the rank fix | RED: expected `#3`, received the stale `#2` |
| Ranked frames render as a thumbnail list and neighboring items shift during drag | `apps/frontend/tests/Workbench.test.tsx` | PASS |
| Existing drop reorder, keyboard navigation, selection and JSON export remain intact | `pnpm test` | PASS: 18 files, 79 tests |
| Production bundle, types and lint are valid | `pnpm build`, `pnpm typecheck`, `pnpm lint` | PASS |

## Motion and sizing follow-up

The follow-up test first failed because the list had no animation/sizing hooks. The fix adds a FLIP-style layout transition for items displaced by the insertion placeholder, plus a larger thumbnail and row layout. The same targeted test and full suite now pass.

`pnpm test:coverage` currently reports 87.88% statements, 87.88% lines, 82.11% functions and 76.43% branches. The branch percentage is below 80% because the new browser-only animation branches are not fully executable in the jsdom suite and existing frontend branches remain uncovered.

## Coverage

`pnpm test:coverage` passed with 79 tests. Coverage was 88.38% statements, 88.38% lines, 82.04% functions and 77.24% branches. The branch percentage remains below 80% because of existing untested branches across the frontend; the new `FrameGrid` component is covered at 92.71% statements and 78.68% branches.

## Implementation notes

- The list uses stable `result_key` values while dragging instead of stale array indexes.
- A local insertion placeholder previews the final position; the parent ranking state changes only after drop.
- The dragged source remains mounted in the list and is taken out of layout flow, preventing native HTML5 drag cancellation while React re-renders the preview.
- The committed order remains the source for the existing top-100 JSON export.
