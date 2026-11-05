# Browser refresh-session replacement acceptance — 2026-10-27

## Result

The bounded local cookie-mode login/registration replacement path is **Implemented**. After credentials and request validation succeed, the backend verifies the refresh capability already presented by the browser, removes its exact stored SHA-256 hash before appending the successor, and publishes the successor cookie only after both datastore operations succeed. Same-account login and cross-account login/registration replacement passed in focused tests; same-account login and cross-account registration passed against a disposable production-Compose stack.

Overall authentication and Phase 15 remain **Experimental**. This slice revokes only the exact predecessor presented by the replacing browser. It is not all-session logout, early access-token revocation, token-family compromise detection, background sweeping, or a transactional cross-account protocol.

## Work board

| Owner | Scope | Acceptance | Evidence | Merge gate |
| --- | --- | --- | --- | --- |
| Primary | Backend replacement protocol, tests, production verifier, docs, Obsidian | Revoke exact predecessor before successor append; no mutation on bad credentials/signature; preserve legacy JSON behavior; fail closed before publication | Focused RED/GREEN, disposable production Compose, exact Mongo hash counts, replay probes | Focused/full tests, builds, static contracts, audit, Compose validation, diff check |
| Independent test audit | Read-only contract and verifier audit | Identify missing same/cross-account, failure, replay, sentinel, and legacy cases | Audit findings were incorporated into the focused suite and live verifier | Required cases present before live execution |
| Independent final review | Read-only implementation/security/evidence review | No unresolved release blocker | Requested twice; the available reviewer accounts hit their usage limit before inspection | Limitation recorded; primary gates remain authoritative for this slice |

## TDD and focused contracts

The initial replacement test file failed **2 of 6** cases: cookie-mode login and registration appended the successor but did not revoke the presented predecessor. After the revoke-before-append implementation, the suite was expanded to ten replacement contracts covering:

- cross-account login and registration ordering;
- same-account login ordering;
- failed login and duplicate registration without predecessor mutation;
- hash-exact cleanup of a correctly signed expired predecessor;
- datastore failure before successor append or `Set-Cookie`;
- bad-signature and malformed cookies without stored-session mutation;
- unchanged legacy JSON multi-session behavior even when an unrelated Cookie header is present.

The final focused gate passed **4 suites / 21 tests** (`authSessionReplacement`, `authRefreshExpiry`, `authPolicy`, and `authCookie`). The backend TypeScript build and production-auth verifier syntax/static contracts also passed.

## Disposable production-Compose acceptance

Command: `npm run production:verify:auth`

Run nonce: `8ee783fa1adb`

The real backend, MongoDB, Redis, ChromaDB, frontend, benchmark worker, and private provider fixture ran in a unique Compose project with unique volumes. The verifier observed:

- a same-account browser login replacement changed the stored predecessor count from one to zero and stored the successor exactly once;
- replaying that predecessor returned 401 and emitted no clearing `Set-Cookie` that could clobber the successor;
- a cross-account cookie-mode registration removed the exact predecessor from account A, stored the successor exactly once on account B, and left an unrelated sentinel session unchanged;
- replaying account A's predecessor returned 401 without cookie clearing, while account B's successor refreshed successfully;
- bad-signature refresh input did not mutate stored sessions;
- the existing ten-session retention, one-winner concurrent rotation, restart persistence, natural expiry/recovery, expired-session cleanup, logout revocation, exact-Origin/CSRF checks, and cookie attributes remained green.

The verifier removed only its nonce-owned containers, networks, volumes, and images. It confirmed the pre-existing `kfive-ai_*` volume identities were unchanged. The ordinary development Compose containers remained running, and no kind cluster exists.

## Security boundary

The presented predecessor is treated as untrusted. A valid signed refresh JWT is removed by decoded user id plus exact hash; a correctly signed expired token is removed by exact hash; malformed, wrong-type, invalid-user-id, or bad-signature values do not mutate stored sessions. Revocation precedes successor append, so a revocation datastore error produces 500 without successor storage or cookie publication.

MongoDB is presently a standalone deployment, so cross-account revoke and append are two operations rather than one transaction. A concurrent stolen-token rotation that wins before the replacement pull can create a separate valid successor, and an append failure after revocation can leave the browser signed out. Registration creates the account before session persistence, matching the existing registration ordering; a datastore failure can therefore leave an account without a session. Token families, reuse detection, all-session revocation, access-token denylisting, and multi-replica/remote race acceptance remain incomplete.

## Delivery gates

- Focused backend auth gate: **4 suites / 21 tests passed**.
- Backend build: **passed**.
- Production-auth verifier syntax/static contracts: **passed**.
- Disposable production-Compose auth drill: **passed**, nonce `8ee783fa1adb`.
- Exact disposable cleanup and protected-volume identity check: **passed**.
- Full backend regression: **81 suites / 544 tests passed**.
- Full frontend regression: **23 files / 160 tests passed**.
- Frontend, backend, and code-runner production builds: **passed**.
- Backend lint: **passed**. A control-character check in the relevant cookie parser was expressed without ESLint's forbidden control-character regex; focused cookie/replacement regression remained **2 suites / 14 tests passed**.
- Production static contracts: **6/6 passed**.
- Docker Compose configuration validation: **passed**.
- Production dependency audit: **6 moderate, 0 high, 0 critical**; available fixes require breaking major changes and were not applied in this slice.
- `git diff --check`: **passed**.

