# Production authentication and dependency hardening verification

Date: 2026-10-24  
State: Experimental  
Final live nonce: `d413b7c4f4fc`

## Work board and merge gate

| Owner | Scope | Acceptance | Evidence | Merge gate |
| --- | --- | --- | --- | --- |
| Primary | Password/token boundaries and refresh storage | 8–72 UTF-8-byte passwords, bounded token inputs, at most ten hashed sessions | Policy tests and backend build | Focused red → green regression |
| Primary | Atomic refresh lifecycle | One winner for simultaneous reuse, restart continuity, supplied-token logout revocation | Disposable production-Compose API/Mongo drill | Exact cleanup and protected-volume identity |
| Security reviewer | Auth and verifier boundary | No unresolved critical/high issue or secret-bearing helper argv | Independent findings and re-review | Findings fixed or bounded explicitly |
| Implementation reviewer | Mongoose/JWT concurrency semantics | Atomic compare-and-swap and no lost concurrent session append | Read-only code/evidence review | GO for bounded Experimental claim |
| Evidence reviewer | State and dependency claims | No complete-auth or production-certification claim | Documentation review | Remaining gaps explicit |

## TDD and focused verification

The initial focused Jest run failed because `backend/src/security/authPolicy.ts` did not exist. The implemented policy tests then passed 3/3 for UTF-8 byte boundaries, bounded refresh input, and the exact Mongo update pipeline. Independent review found that malformed/invalid signatures still caused a Mongo `$pull`; a fourth test now proves only `TokenExpiredError` permits rejected-token cleanup, while bad signatures and untrusted errors do not. The final focused policy result is 4/4.

`npm run test:production` passed all three production contract files. `npm run build:backend` passed. The final post-review backend regression on 2026-10-25 passed 77 suites / 522 tests. Jest reported its existing forced worker-exit warning after all assertions passed; that teardown warning remains a separate test-harness follow-up. The dependency-only change also passed frontend 22 files / 138 tests and both frontend/backend builds.

Two live-harness red iterations did not represent product failures. Inherited Docker build output returned `null` and exposed a missing null guard; the wrapper is now null-safe. This host's known AppArmor defect blocked `docker compose exec`, and the first private Mongo helper invoked an entrypoint that needed dropped privileges. The final inspector is a short-lived client on the private data network with no published port, a read-only root, bounded tmpfs, all capabilities dropped, `no-new-privileges`, and a constant shell entrypoint. Security review also caught a root password in helper argv after one failed ephemeral run; that disposable stack and secret were destroyed, and the final verifier passes the secret through a child environment variable with a regression that forbids the old argv pattern. No secret value is retained here.

## Live matrix

The final `npm run production:verify:auth` run built a uniquely tagged backend and used an isolated production-Compose project. It returned:

| Contract | Result |
| --- | --- |
| Register with `é` repeated 37 times (74 UTF-8 bytes) | HTTP 400; zero matching Mongo users |
| Registration plus twelve successful logins | Exactly ten stored refresh hashes |
| Oldest login refresh after cap eviction | HTTP 401 |
| Same newest refresh sent simultaneously twice | Exactly `[200, 401]` |
| Winner's rotated refresh after backend restart | HTTP 200 |
| Logout with next rotated refresh | HTTP 200, then the same refresh returned 401 |
| Stored hashes after logout | 9 (evidence, not a normative target) |
| Exposure | Frontend loopback only; API and datastores private |
| Cleanup | Exact project containers, networks, five volumes, and two tagged images absent; known `kfive-ai_*` volume identities unchanged |

The Mongo filter includes both user ID and the consumed hash, and the update pipeline removes that hash, appends a uniquely identified successor hash, and slices to the latest ten. This makes the stored capability one-use at the shared database boundary; the live result validates the behavior for two racing requests through one API container.

## Dependency audit

Exact direct upgrades changed backend Axios 1.18.0 → 1.20.0, backend Multer 2.2.0 → 2.5.0, and frontend Axios 1.18.0 → 1.20.0, with compatible lockfile resolutions. The final `npm audit --omit=dev --json` reported 427 production dependencies and 8 moderate, 0 high, 0 critical findings. Its nonzero exit reflects the remaining findings. They are in Tailwind/PostCSS, React Router, and BullMQ/UUID paths; their advertised changes require separate compatibility and reachability review. This is not a clean-security claim.

## Claim boundary

Proven: bounded password/token inputs, hash-only refresh storage, ten-session retention, one-use concurrent refresh rotation, restart continuity, supplied-token logout revocation, private disposable topology, and exact cleanup.

This historical API slice did not prove browser-safe refresh transport or CSRF. The later [browser refresh-cookie acceptance](production-auth-cookie-live.md) removes the refresh capability from browser-readable storage and proves the bounded local cookie/Origin/CSRF path; [access-expiry acceptance](production-auth-expiry-live.md) proves natural access expiry/recovery, [refresh-expiry acceptance](production-auth-refresh-expiry-live.md) proves lazy cleanup of one correctly presented expired session, and [cross-tab acceptance](production-auth-cross-tab-live.md) proves a bounded two-tab Chromium/Web Locks path. Still not proven: access-token revocation before expiry, background expired-session sweeping, all-session logout, token-family compromise detection, password reset, email verification, MFA, key rotation, migration of historical passwords over 72 bytes, no-Web-Locks/broader-browser behavior, multiple API replicas, or remote-host operation. Session-cap eviction is intentionally silent. Authentication and the overall Phase 15 security review remain Experimental.
