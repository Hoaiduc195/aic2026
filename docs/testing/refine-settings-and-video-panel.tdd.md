# Refine settings scrollbar and resize video panel — TDD evidence

## User journey

As a search operator, I want the settings panel to keep a discreet scrollbar and the selected-frame video panel to be resizable, so that the workspace remains comfortable on different screen sizes.

## TDD evidence

| Stage | Command | Result |
|---|---|---|
| RED | `pnpm test -- tests/Workbench.test.tsx -t "resizes the video panel"` | 1 test failed because the video inspector had no accessible resize separator. |
| GREEN | `pnpm test -- tests/Workbench.test.tsx -t "resizes the video panel"` | 1 test passed; keyboard resizing updates the panel width. |
| Full suite | `pnpm test` | 15 test files, 63 tests passed. |
| Coverage | `pnpm test:coverage` | 88.04% statements/lines, 86% functions, 77.77% branches. |
| Static checks | `pnpm typecheck`, `pnpm lint`, `pnpm build` | All passed. |

## Guarantees

- The settings panel keeps scrolling, but its scrollbar is thin, transparent-track, and visually subdued.
- The desktop video/frame inspector exposes a vertical resize handle with a 300–640px width range.
- Dragging the handle resizes the panel; keyboard users can use Left/Right, Home, and End on the same separator.
- The resize handle is hidden when the inspector becomes a full-width mobile panel.

## Checkpoints

- RED checkpoint: `1957d4d test: add video panel resize coverage`
- GREEN implementation checkpoint: `f33f0b1 fix: refine settings scrollbar and resize video panel`
