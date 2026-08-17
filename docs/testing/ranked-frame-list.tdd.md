# Ranked frame list drag preview — TDD evidence

## Source and journey

The implementation plan was derived from the ranked-frame workflow discussion.

As a qualification operator, I want ranked frame results rendered as a vertical thumbnail list and want neighboring items to shift while I drag a frame, so that I can curate the final ranking before exporting the top 100 results.

## Execution evidence

| Guarantee | Test or command | Result |
|---|---|---|
| The new list behavior is covered by an executable test | `pnpm test -- Workbench.test.tsx` before implementation | RED: 1 of 18 tests failed because the list and insertion preview did not exist |
| Preview ranks follow the pending insertion position | `pnpm test -- Workbench.test.tsx -t "thumbnail list"` before the rank fix | RED: expected `#3`, received the stale `#2` |
| Pointer drag starts and reorders a result | `pnpm test -- Workbench.test.tsx -t "pointer drag and drop"` before the pointer implementation | RED: the result order stayed unchanged |
| Ranked frames render as a thumbnail list and neighboring items shift during drag | `apps/frontend/tests/Workbench.test.tsx` | PASS |
| Existing drop reorder, keyboard navigation, selection and JSON export remain intact | `pnpm test` | PASS: 18 files, 79 tests |
| Production bundle, types and lint are valid | `pnpm build`, `pnpm typecheck`, `pnpm lint` | PASS |

## Motion and sizing follow-up

The follow-up test first failed because the list had no animation/sizing hooks. The fix adds a FLIP-style layout transition for items displaced by the insertion placeholder, plus a larger thumbnail and row layout. A later browser check found that native HTML5 drag was not reliably starting after React preview updates, so the interaction now uses pointer events with a six-pixel movement threshold. This supports mouse and touch drag while preserving normal click selection and the separate ↑/↓ controls.

The browser smoke test moved the third result to the first position and observed one active drag item plus the `#1` insertion placeholder.

## Coverage

`pnpm test:coverage` passed with 79 tests. Coverage was 88.07% statements, 88.07% lines, 82.25% functions and 77.05% branches. The branch percentage remains below 80% because of existing untested branches across the frontend; `FrameGrid.tsx` is covered at 87.42% statements and 75.4% branches.

## Implementation notes

- The list uses stable `result_key` values while dragging instead of stale array indexes.
- A local insertion placeholder previews the final position; the parent ranking state changes only after drop.
- Pointer drag keeps the source mounted, previews the insertion position, and suppresses accidental click selection after a real drag begins.
- The committed order remains the source for the existing top-100 JSON export.
