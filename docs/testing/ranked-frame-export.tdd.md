# Ranked frame export TDD evidence

## Source plan

Derived from the implementation plan for the AIC sơ tuyển result panel: reorder
the Textual KIS frame ranking and export the ordered top 100 answers.

## User journeys

- As an operator, I can drag a result frame to a new position so the submitted
  ranking reflects the order I chose.
- As an operator, I can use keyboard move controls when drag-and-drop is not
  available.
- As an operator, I can export the ordered Textual KIS results as the current
  `{ query_id, task, answers }` JSON envelope, capped at 100 answers.
- Q&A and TRAKE continue to use the existing answer drawer workflow.

## Evidence

| Guarantee | Test | Result |
|---|---|---|
| Reordering does not mutate the source list and export is capped at 100 | `tests/workbench-model.test.ts` | PASS |
| Keyboard move controls update order and preserve focus on the moved frame | `tests/Workbench.test.tsx` | PASS |
| Native drag-and-drop changes the visible ranking | `tests/Workbench.test.tsx` | PASS |
| Export JSON preserves the reordered answer sequence | `tests/Workbench.test.tsx` | PASS |
| Existing workbench flows remain green | `pnpm test` | PASS: 76 tests |
| Frontend typecheck and lint | `pnpm typecheck`, `pnpm lint` | PASS |
| Production build | `pnpm build` | PASS |

## Coverage and known gaps

`pnpm test:coverage` passed with 88.36% statements, 81.96% functions and
77.37% branches across the frontend suite. Branch coverage is below 80% because
of existing untested branches in the wider application; the new reorder/export
paths are covered by model and Workbench tests.

The Playwright qualification suite was attempted but did not complete because
the reused Next dev server intermittently failed to hydrate the sidebar. The
failures were that the task tab did not change or the search button remained
disabled after the field was filled. This is an environment/dev-server issue
outside the ranked frame panel; it should be rerun against a fresh server.
