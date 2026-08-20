# VQA worker pool TDD report

## User journey

As a VQA user, I want batch answering for up to 100 ranked frames to run with bounded concurrency, so that the batch completes in roughly 1–2 minutes without flooding the VLM service.

## Implemented behavior

- Replaced the serial VQA batch loop and fixed 3.3-second delay with a bounded worker pool.
- Frontend runs the batch with four workers and preserves the original ranked-frame order in the returned results.
- Failed frames do not stop the remaining workers; skipped frames and progress reporting remain supported.
- Raised the VQA answer route limit to 120 requests per 60 seconds, matching the backend global throttle capacity and allowing a 100-frame batch to complete within one rate window when model latency permits.

## TDD evidence

| # | Guarantee | Test | Result |
|---|---|---|---|
| 1 | Worker pool never exceeds the configured concurrency and returns results in input order. | `apps/frontend/tests/vqa-batch.test.ts` | PASS |
| 2 | Existing top-K, failure continuation, skip handling, and progress behavior remain intact. | `apps/frontend/tests/vqa-batch.test.ts` | PASS |
| 3 | VQA answer endpoint advertises at least 100 requests per 60 seconds. | `apps/backend/tests/vqa-answer-throttle.test.ts` | PASS |

## RED/GREEN checkpoints

- RED: `pnpm --dir apps/frontend test -- vqa-batch.test.ts` failed because the observed maximum concurrency was `1` instead of `2`.
- RED: with the previous VQA limit temporarily set to `20`, `pnpm --dir apps/backend test -- vqa-answer-throttle.test.ts` failed because `20` was below the required `100`.
- GREEN: focused frontend and backend tests passed after the worker pool and rate-limit changes.

## Verification

- Frontend full test suite: PASS.
- Backend full test suite: PASS — 33 files, 128 tests.
- Frontend typecheck: PASS.
- Backend typecheck: PASS.
- Frontend lint: PASS.
- Frontend production build: PASS.
- Backend production build: PASS.
- Frontend and backend coverage commands completed successfully with configured thresholds.

## Known limitation

The 1–2 minute target depends on VLM latency, R2 download time, and model capacity. Four workers provide the requested bounded parallelism; they do not guarantee a fixed wall-clock time if the configured VLM timeout is very high or the model is overloaded.
