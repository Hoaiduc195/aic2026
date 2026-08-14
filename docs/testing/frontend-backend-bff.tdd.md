# Frontend–Backend BFF Integration TDD Evidence

## Source plan

Derived from the conversational implementation plan for connecting the
Next.js workbench to the NestJS retrieval backend.

## User journeys

1. An operator searches Vietnamese video descriptions and receives backend
   search results through the Next.js `/api` boundary.
2. An operator opens a result, loads playback/frame context, and receives
   browser-safe media URLs from the backend/R2 path.
3. An operator queues answers, saves a selection revision, and creates a
   submission preview without exposing the backend token to the browser.
4. A backend outage produces a safe `502` response instead of an internal
   error or leaked upstream details.

## RED evidence

Command:

```text
pnpm test -- tests/search-route.test.ts tests/backend-media-routes.test.ts tests/api.test.ts tests/Workbench.test.tsx
```

Initial result: 7 intended failures. The failures were caused by the missing
server-side proxy token handling, media proxy routes, manual API methods, and
drawer save/preview actions.

## GREEN evidence

| Guarantee | Test | Result |
|---|---|---|
| BFF forwards only the server-side backend token | `tests/search-route.test.ts`, `tests/backend-media-routes.test.ts`, `tests/manual-routes.test.ts` | PASS |
| Upstream errors are sanitized and network failures return `502` | `tests/search-route.test.ts` | PASS |
| Playback, frame context and keyframe redirect use backend/R2 data | `tests/backend-media-routes.test.ts` | PASS |
| Manual candidate/selection/preview routes validate and proxy requests | `tests/manual-routes.test.ts` | PASS |
| Frontend `qa` maps to backend `vqa` and responses are runtime-validated | `tests/api.test.ts` | PASS |
| Workbench saves selection and creates preview | `tests/Workbench.test.tsx` | PASS |
| Complete frame-first operator flow works in the browser | `tests/e2e/qualification.spec.ts` | PASS |

Commands and results:

```text
apps/frontend: pnpm test:coverage  -> 39/39 passed; 86.95% lines, 80.62% branches
apps/frontend: pnpm typecheck       -> passed
apps/frontend: pnpm lint            -> passed
apps/frontend: pnpm build           -> passed
apps/frontend: pnpm test:e2e        -> 2/2 passed
apps/backend:  npm test             -> 34/34 passed
apps/backend:  npm run typecheck    -> passed
apps/backend:  npm run build        -> passed
```

## Known gaps

- Tests mock the backend and signed R2 URLs; a live Neon/R2 deployment smoke
  test still needs environment-specific credentials and data.
- Production access to the operator-only frontend remains a deployment or
  reverse-proxy responsibility; `BACKEND_OPERATOR_TOKEN` is server-only and
  must not be exposed through `NEXT_PUBLIC_*` variables.
