# Center settings modal — TDD evidence

## User journey

As a search operator, I want the settings panel to stay centered in the viewport, independently of the sticky topbar and the page layout behind it.

## TDD evidence

| Stage | Command | Result |
|---|---|---|
| RED | `pnpm test -- tests/Workbench.test.tsx -t "keeps numeric settings editable"` | 1 test failed: the dialog was still a direct child of `.app-topbar`, not a dedicated modal layer. |
| GREEN | `pnpm test -- tests/Workbench.test.tsx -t "keeps numeric settings editable"` | 1 test passed. |
| Full suite | `pnpm test` | 15 test files, 62 tests passed. |
| Coverage | `pnpm test:coverage` | 88.67% statements/lines, 87.62% functions, 77.97% branches. |
| Static checks | `pnpm typecheck`, `pnpm lint`, `pnpm build` | All passed. |

## Guarantees

- The settings dialog is rendered through a portal attached to `document.body`.
- A full-viewport overlay owns the backdrop and centers the dialog with a dedicated layout layer.
- The dialog remains scrollable on short screens and keeps responsive margins on mobile.
- Existing focus restoration, Escape-to-close, settings inputs, and backdrop close behavior remain intact.

## Checkpoints

- RED checkpoint: `1d82869 test: reproduce settings modal offset`
- GREEN implementation checkpoint: `7c9db05 fix: center settings modal in viewport`
