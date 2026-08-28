# Context export controls TDD evidence

## User journeys

- As a user, I can see `Context export` above the ranked frame list.
- As a user, I can set the number of context frames included in the export.
- As a user, I can set the source-frame spacing used to cover the selected context.
- As a user, I can see newly loaded context frames inserted directly below the selected center frame in the main ranked result list.
- As an operator, I can fill an answer queue from an expanded result list without exceeding 100 items.
- As an operator, I receive the same Top-K and spacing values through the BFF and backend media route.

## RED/GREEN evidence

| Stage | Result |
|---|---|
| RED | Frontend suite reported 5 intended failures for the missing spacing control, query parameter, and stepped selection. |
| RED (merge follow-up) | Frontend suite reported 2 intended failures for appending the nearby frame to the main result list and exposing the merge helper. |
| RED (placement follow-up) | The model test failed with `[385, 900, 411]` instead of placing context frame `411` directly after center frame `385`. |
| GREEN | Frontend: 31 files, 199 tests passed. Backend: 33 files, 152 tests passed. |
| E2E | Chromium: 5/5 tests passed, including Context export. |
| Static/build checks | Frontend and backend typecheck/build passed; frontend lint passed. |
| Coverage | Frontend lines 89.48%. Backend test suite passes; repository-wide coverage is 75.9% and remains below its existing 80% threshold. |

## Guarantees

| # | Guarantee | Test |
|---|---|---|
| 1 | Context export renders before the ranked frame list. | `apps/frontend/tests/Workbench.test.tsx` |
| 2 | Top-K and source-frame spacing are validated independently. | `apps/frontend/tests/nearby-frame-panel.test.tsx`, `nearby-frame-export.test.ts` |
| 3 | Spacing is forwarded through the frontend API, BFF, controller, service, and repository. | `apps/frontend/tests/api.test.ts`, `backend-media-routes.test.ts`, `apps/backend/tests/media-repository.test.ts`, `media.service.test.ts` |
| 4 | Local fallback and Postgres selection return a chronological, bounded frame window. | `apps/frontend/tests/media-adapter.test.ts`, `apps/backend/tests/media-repository.test.ts` |
| 5 | Loaded context frames are inserted immutably directly below the center frame, deduplicated by source-frame identity, and can expand the result list; answer-queue fill remains capped at 100. | `apps/frontend/tests/workbench-model.test.ts`, `Workbench.test.tsx` |
