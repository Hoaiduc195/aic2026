# TRAKE overview query TDD evidence

## User journey

As an AIC operator, I want to enter one overall TRAKE query before the ordered
sub-events, so that retrieval receives the full temporal context while each
event still maps to one ordered frame.

## Validation evidence

| Guarantee | Test | Result |
|---|---|---|
| TRAKE shows a required `Truy vấn chính` field before the event editor | `apps/frontend/tests/Workbench.test.tsx` — `keeps task input...` | PASS |
| TRAKE search sends the overview followed by numbered events | `apps/frontend/tests/Workbench.test.tsx` — `submits the TRAKE overview query...` | PASS |
| Query Improver writes the improved overview and each event back to their inputs | `apps/frontend/tests/Workbench.test.tsx` — `improves the TRAKE overview...` | PASS |
| Backend Query Improver preserves the overview and event ordering | `apps/backend/tests/query-improver.test.ts` — `preserves the TRAKE overview...` | PASS |

## RED/GREEN checkpoints

- RED: the new frontend test could not find `Truy vấn chính`; the backend test
  incorrectly renumbered the overview as event 1.
- `6caa7bd` — `test: require TRAKE overview query`
- `f21b718` — `test: preserve TRAKE overview in query improvement`
- GREEN: the targeted TRAKE tests passed after the UI, query builder, and
  backend parser/prompt changes.

## Full validation

- Frontend: `pnpm test` — 25 files, 127 tests passed.
- Backend: `pnpm test` — 32 files, 127 tests passed.
- Frontend coverage: 89.46% statements/lines, 83.42% functions.
- Backend coverage: 84.90% statements/lines, 93.65% functions.
- Frontend lint, typecheck, and build passed.
- Backend typecheck and build passed.
