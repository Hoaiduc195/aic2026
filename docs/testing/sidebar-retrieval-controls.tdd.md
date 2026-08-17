# Sidebar retrieval controls — TDD evidence

## User journey

As a search operator, I want to adjust the number of returned frames and retrieval candidate pools directly in the left sidebar, so that I can tune a query without opening the general settings modal.

## TDD evidence

| Stage | Command | Result |
|---|---|---|
| RED | `pnpm test -- tests/Workbench.test.tsx` | 11 passed, 1 failed: the sidebar did not expose `Số frame hiển thị`. |
| GREEN | `pnpm test -- tests/Workbench.test.tsx` | 12 passed. The sidebar values are forwarded in the search request. |
| Full suite | `pnpm test` | 15 test files, 61 tests passed. |
| Coverage | `pnpm test:coverage` | 88.62% statements, 88.62% lines, 87.56% functions. |
| Static checks | `pnpm typecheck`, `pnpm lint`, `pnpm build` | All passed. |

## Guarantees

- The left sidebar exposes `display_k`, `branch_k`, and `fusion_k` with the same validation and persistence handlers used by the existing retrieval settings.
- Clearing a numeric field is supported as an intermediate input state; invalid values are rejected before search.
- Saving or resetting retrieval settings updates the shared Workbench state, so the next search sends the configured values.
- Retrieval controls were removed from the general settings modal to avoid two separate editors for the same state. The modal remains focused on LLM and embedding configuration.

## Checkpoints

- RED checkpoint: `f3246fd test: move retrieval controls to sidebar`
- GREEN implementation checkpoint: `ef83a09 fix: move retrieval controls to sidebar`

## Known gaps

Branch coverage is below 80% because the existing Workbench suite does not exercise every error and reset branch. Statement and line coverage remain above the repository's 80% target.
