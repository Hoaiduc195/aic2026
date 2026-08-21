# Frame inspector media actions TDD evidence

## Source plan

Derived from the user request to remove the neighboring-frame button from the right frame inspector sidebar.

## User journeys

- As a user, I can inspect the selected frame and its evidence without an extra neighboring-frame filmstrip in the sidebar.
- As a user, I can open Video Studio from the sidebar to browse canonical/keyframes and exact frame controls.
- As a TRAKE user, I can still select another frame in Video Studio and assign it to an event.

## RED/GREEN evidence

| Stage | Command | Result |
|---|---|---|
| RED | `pnpm test -- Workbench.test.tsx` | 1 intended failure: the old neighboring-frame button was still rendered; 27 existing tests passed. |
| GREEN | `pnpm test -- Workbench.test.tsx` | 28 tests passed. |
| Full verification | `pnpm test` | 24 files, 114 tests passed. |
| Coverage | `pnpm test:coverage` | 88.55% statements, 76.16% branches, 83.28% functions. |
| Static/build checks | `pnpm typecheck`, `pnpm lint`, `pnpm build` | Passed. |

## Guarantees

| # | Guarantee | Test |
|---|---|---|
| 1 | The right inspector no longer renders the neighboring-frame button or filmstrip. | `tests/Workbench.test.tsx` |
| 2 | Opening the selected frame does not request neighboring frames. | `tests/Workbench.test.tsx` |
| 3 | Video Studio remains available from the inspector. | `tests/Workbench.test.tsx` |
| 4 | TRAKE can still select a second frame through Video Studio and assign it. | `tests/Workbench.test.tsx` |
| 5 | The media action layout uses the full available inspector row for Video Studio. | `src/app/globals.css` |

## Known environment gap

`pnpm test:e2e` was attempted but could not validate the browser flow because an existing process occupied port 3000. The Playwright web server fell back to port 3001 while the configured base URL remained `http://127.0.0.1:3000`, so both tests loaded the stale server. No unrelated process was stopped.

## Checkpoints

- `4ef5c58 test: remove inspector neighboring frame action` — RED test checkpoint.
- `a865dc5 fix: simplify frame inspector media actions` — GREEN implementation checkpoint.
- `413753b test: align studio e2e flow` — test naming cleanup.
