# Knowledge history pagination acceptance — 2026-11-21

Implemented cursor history returns at most 50 metadata records plus a continuation token. The immutable ObjectId order avoids timestamp ties; workspace, owned project, and deleted-project recovery filters remain in the database query. Legacy callers without a cursor retain the prior bounded response during migration. The UI uses the paginated response, invalidates stale page requests, and rejects malformed, duplicate, out-of-order, or inconsistent continuation data.

[Machine-readable result](knowledge-pagination-live.json) records a live pass over 388 seeded records in isolated MongoDB: 217 workspace, 103 project, 57 orphaned, and 11 second-user records. The compiled API passes exact traversal, cross-owner rejection, malformed/mixed cursor rejection, continuation after cursor-record deletion, concurrent insertion, and API restart. This is metadata-history acceptance, not ingestion proof.

Installed Chrome exercises real disposable-user login, five workspace pages, all project and recovery pages, Previous/Next controls, and returning to workspace. Exact visible names remain within scope with no duplicates; no page runtime errors occur. [Pagination control screenshot](knowledge-pagination.png).

All nonce-owned containers/network were removed and existing Docker volume identities preserved. No inference calls were made. Backend build/lint and 50 focused tests, frontend build/lint and 16 focused tests passed. Browser dependency status can report unavailable because this fixture has no Chroma or embedding service.

Reproduce with `npm run verify:knowledge-pagination`. For the browser path, build frontend/backend and set `KFIVE_PLAYWRIGHT_MODULE` to an installed module, then run `node scripts/verify-benchmark-host-live.cjs --allow-live-test --knowledge-pagination --browser`. The existing acceptance harness is reused only for isolated infrastructure, authentication, and cleanup.

The cursor is a traversal boundary, not a snapshot transaction: newly inserted records above it appear when returning to the first page. Records deleted during traversal may disappear. No global history quota or durable indexing/recovery is established by this check. Those requirements remain pending, along with remote/Kubernetes acceptance.
