# Query Improver TDD Evidence

## User journeys

- Người dùng có thể đọc query tiếng Việt, tạo một query tiếng Anh rõ ràng hơn và kiểm tra/chỉnh sửa preview trước khi tìm kiếm.
- TRAKE giữ nguyên số lượng và thứ tự sự kiện khi query lớn được cải thiện trong một lần gọi model.
- Khi model không khả dụng hoặc trả output sai, hệ thống dùng query gốc thay vì làm hỏng retrieval.

## Validation evidence

| Guarantee | Test/command | Result |
|---|---|---|
| Query improver trả về một query tiếng Anh duy nhất | `apps/backend/tests/query-improver.test.ts` | PASS: 4 tests |
| TRAKE giữ nguyên số dòng/thứ tự | `apps/backend/tests/query-improver.test.ts` | PASS |
| Model unavailable/invalid output fallback về query gốc | `apps/backend/tests/query-improver.test.ts` | PASS |
| Request model URL và task được validate | `apps/backend/tests/query-improver-request.test.ts` | PASS: 2 tests |
| Endpoint được auth, throttle và gọi đúng service | `apps/backend/tests/api.integration.test.ts` | PASS: 6 tests |
| Frontend proxy không forward endpoint không an toàn | `apps/frontend/tests/query-improver-route.test.ts` | PASS: 2 tests |
| Frontend preview được tạo trước khi search và query preview được dùng | `apps/frontend/tests/Workbench.test.tsx` | PASS: 20 tests |
| Client API parse đúng contract query improver | `apps/frontend/tests/api.test.ts` | PASS: 13 tests |

## Commands

- `apps/backend`: `pnpm test` — PASS, 28 files / 99 tests.
- `apps/backend`: `pnpm test:coverage` — PASS, 86.98% statements and lines.
- `apps/backend`: `pnpm typecheck` — PASS.
- `apps/backend`: `pnpm build` — PASS.
- `apps/frontend`: `pnpm test` — PASS, 21 files / 87 tests.
- `apps/frontend`: `pnpm test:coverage -- --testTimeout=15000` — PASS, 87.72% statements and lines.
- `apps/frontend`: `pnpm typecheck` — PASS.
- `apps/frontend`: `pnpm lint` — PASS.
- `apps/frontend`: `pnpm build` — PASS.

## Scope notes

- Không thêm schema database.
- Không sinh query variants hoặc chạy retrieval nhiều lần cho query improver.
- Query variants nội bộ của planner dành cho cấu trúc TRAKE vẫn được giữ nguyên.
- Chưa tạo commit/push trong bước này; worktree còn các thay đổi local có sẵn từ trước.
