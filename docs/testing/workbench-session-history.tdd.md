# Workbench session and query history TDD evidence

## Source and user journeys

The implementation was derived from the conversational plan for preserving workspaces when switching qualification tasks and restoring successful queries from a `Lịch Sử` panel.

- A user can switch between Textual KIS, Hỏi & Đáp, and TRAKE without losing each task's inputs or results.
- A successful text or frame query is saved locally and can be restored from `Lịch Sử`.
- The browser keeps one stable workbench `session_id` for retrieval requests.

## Validation evidence

| Guarantee | Test | Result |
|---|---|---|
| Session ID is stable and history storage is bounded to 50 entries | `tests/workbench-history.test.ts` | PASS |
| Malformed local history does not break the workbench | `tests/workbench-history.test.ts` | PASS |
| Task workspaces are restored independently | `tests/Workbench.test.tsx` | PASS |
| Successful query history opens and restores the result workspace | `tests/Workbench.test.tsx` | PASS |
| Browser-level task switching and history restoration work | `tests/e2e/qualification.spec.ts` | PASS |

Commands run:

- `pnpm test` — 122 tests passed.
- `pnpm test:coverage` — 89% statements/lines, 76.32% branches, 83.42% functions.
- `pnpm test:e2e` — 3 tests passed.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed with no warnings.
- `pnpm build` — passed.

## Implementation notes

- History is browser-local and stores at most 50 successful query snapshots.
- API keys and LLM/VLM settings are not included in snapshots.
- A localStorage failure is non-fatal; search continues even if history cannot be written.
