# Code Lab critical live acceptance — 2026-09-23

Result: **Complete** for the currently supported Python/JavaScript Code Lab path.

## Fixes under verification

- Terminal BullMQ jobs remain `cancel-requested` until their retained result is reconciled into MongoDB; cancellation no longer replaces a valid delayed result with `internal_error`.
- The API producer, API heartbeat/cancellation client, worker, and worker health check all resolve `QUEUE_REDIS_URL` before `REDIS_URL`.

## Focused regressions

- Backend: `codeRunService`, `codeRunReconciler`, Redis, and queue configuration — **4 suites, 38/38 tests passed**.
- Backend TypeScript build — **passed**.
- Code-runner worker — **30/30 tests passed**.
- Code-runner TypeScript build — **passed**.
- Frontend Code Lab model — **5/5 tests passed**.
- `git diff --check` — **passed**.

## Production path

The live topology was the production frontend and API, authenticated Redis, the dedicated code-runner worker, disposable Docker runtime containers, and MongoDB. A dedicated browser account used the actual Code Lab page.

- Browser run `6ab3ea6dda332c7a46aff492`: create API returned HTTP 202; the UI reached `succeeded` and showed `CODE-LAB-LIVE:persist-20260923`. The retained BullMQ result and Mongo record both reported the same output and exit code 0.
- Browser cancellation `6ab3eab7da332c7a46aff4b4`: create API returned HTTP 202; the UI Stop action returned HTTP 200; the UI reached `cancelled` and retained `CODE-LAB-CANCEL:started`. Redis and Mongo both reported `cancelled`, the cancellation marker was removed, and no labeled runtime container remained.
- After restarting both `backend` and `code-runner`, readiness returned MongoDB/Redis available, the worker was healthy, and a browser reload reopened both saved records with their original outputs and statuses.
- Dedicated queue configuration was then exercised live: general Redis remained database 0 while `QUEUE_REDIS_URL` selected database 1. Browser run `6ab3ec1ae629ed67ba627aa4` succeeded with `CODE-LAB-QUEUE-DB1:ok`; the job was absent from database 0, present with its result in database 1, and the database-1 worker heartbeat was live.
- The verified images were promoted to the normal local tags and the repository's standard `--with-code-lab --no-build` configuration was restored. A final browser reload still reopened all three Mongo-backed records, including the cancelled result.
- Browser console error check: **0 errors**.

The npm registry returned `ECONNRESET` during a clean dependency-layer rebuild. The live acceptance therefore used dependency-free verification images that overlay the freshly compiled backend and worker artifacts onto the existing production images. No test result above depends on a mocked Redis, worker, Docker executor, MongoDB, or browser API.

## Scope

This completion claim covers the supported Python/JavaScript critical path only. Additional requested languages, immutable runtime-image digest policy, and public multi-tenant certification remain outside this claim.
