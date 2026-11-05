# Expired refresh-session cleanup verification

Date: 2026-10-26  
State: bounded local presented-session cleanup **Implemented**; overall authentication and Phase 15 **Experimental**

## Accepted contract

A correctly signed refresh JWT that has naturally expired is removed lazily when it is presented through an authenticated refresh request. Cookie mode must first pass the explicit transport header, exact allowed Origin, and token-bound CSRF proof. Cleanup uses an atomic Mongo `$pull` scoped to the SHA-256 hash of that exact token. The public response is no-store and generic. The server clears the matching browser cookie only when the mutation actually consumed the stored hash; an absent expired predecessor cannot emit a clearing cookie that might overwrite a successor. Invalid signatures and other untrusted JWT failures do not mutate stored sessions.

This is request-triggered cleanup of one presented session. It is not a background sweep, all-session cleanup, or permission to inspect/print stored tokens.

## Work board and merge gate

| Owner | Scope | Acceptance | Evidence | Merge gate |
| --- | --- | --- | --- | --- |
| Primary | TDD fix, API/container and browser execution | Exact expired hash `1 → 0`, unrelated session retained, stale replay safe, browser fail-closed | Tests, nonce output, browser requests/state, Mongo counts | Focused/full regressions, builds, static contracts, audit, cleanup |
| Implementation review | Route/verifier correctness | No false cleanup or overclaim | Read-only source/evidence review | GO |
| Security review | Origin/CSRF, mutation scope, response race, diagnostics | No token disclosure or successor-cookie clobber | Read-only threat review | GO |
| Evidence review | Claims/state/docs/Obsidian | Every claim bounded to artifacts | Read-only final audit | GO |

## TDD and automated verification

- Route RED: `backend/src/routes/authRefreshExpiry.test.ts` initially passed stored-expired cleanup and bad-signature no-write cases but failed the stale-predecessor case because a hash-absent expired request still returned `Set-Cookie: ... Max-Age=0`. GREEN: cookie clearing is now conditional on `modifiedCount === 1`; the focused route file passes 3/3.
- Verifier-contract RED: `scripts/production-auth.test.cjs` failed before the 60-second lifetime, refresh-claim parser, exact before/after Mongo checks, stale replay, invalid-signature, and output fields existed. GREEN: the static verifier contract and syntax checks pass.
- Focused backend security/config/auth gate: 5 suites / 42 tests passed.
- Full backend: 80 suites / 534 tests passed. Jest retained its existing forced-worker-exit warning after success.
- Full frontend: 22 files / 147 tests passed.
- Backend and frontend production builds passed. Vite retained its existing large-chunk warning.
- All six production contract files passed.
- `npm audit --omit=dev --audit-level=high` passed with 0 critical/high and 6 moderate findings in the currently resolved PostCSS selector parser, React Router, and BullMQ/UUID paths; their available fixes require separately reviewed breaking/range changes.
- Development Compose readiness returned `ready` after restoration, and `git diff --check` passed after evidence/documentation updates.

## Disposable production-Compose acceptance

Final nonce: `590c580edbff`.

The isolated verifier configured `JWT_REFRESH_EXPIRES_IN=60s`, the minimum accepted lifetime, while retaining the earlier four-second access-expiry checks. It decoded only bounded JWT claims and asserted refresh `type`, issuer, audience, integer `iat`/`exp`, and exact `exp - iat = 60`. Token, cookie, CSRF, locally derived hashes, generated credentials, and private temporary paths were registered with the diagnostic redactor before use.

Two fresh sessions were issued for the disposable user: the target cookie session and an unrelated sentinel. Private Mongo queries returned only `{target, sentinel, total}` counts—never hashes or token arrays. The target and sentinel each occurred exactly once before expiry. After the signed expiry but before any request, the state was unchanged, proving elapsed time alone did not remove the hash.

The correctly authenticated expired-cookie request returned exact 401 `Invalid or expired refresh token`, `Cache-Control: no-store`, no successor credentials, and the exact secure clearing cookie. The target count changed from one to zero, the sentinel remained one, and total count decreased exactly by one. Replaying the expired predecessor returned 401 with no `Set-Cookie` and no database change. A signature-bit mutation with a correctly derived CSRF proof returned 401, emitted no clearing cookie, and caused no session mutation. Backend restart preserved the target absence and sentinel presence.

The verifier then removed only nonce-owned containers, networks, five volumes, and two labelled images. No nonce resources remained, and every pre-existing protected volume identity was unchanged.

## Real-browser acceptance

The running development backend was rebuilt, then recreated alone with a temporary 15-minute access lifetime and 60-second refresh lifetime. A fresh browser registered `refresh-expiry-20261026@example.invalid` through the Compose frontend. The access JWT declared `type: access` and an exact 900-second lifetime; local auth state contained no refresh token. Cookie metadata—not its value—showed one host cookie with `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and a future expiry. Mongo reported one user and one stored session.

After waiting beyond refresh expiry, navigation to Projects returned 200 and rendered the page, proving the access JWT remained valid and isolating refresh expiry. Reload then made exactly one `POST /api/v1/auth/refresh` request, which returned 401. There was no protected retry or refresh loop. The browser reached `/login`, its cookie list was empty, and persisted user/access/CSRF values were null with `isAuthenticated: false`. Mongo session count was zero. A second reload stayed on `/login` and added no refresh request.

The console contained one expected failed-resource 401 for the deliberately expired refresh plus existing password-autocomplete notices; no persistent authentication error remained. Exact Mongo cleanup returned `{conversations: 0, users: 1, remaining: 0}`. The browser was closed. The backend was recreated without the temporary override, and ordinary local readiness returned `ready` with MongoDB and Redis available. No persistent volume was removed.

## Boundaries

Proven: natural refresh expiry rather than token corruption; exact hash presence before expiry and before use; hash-exact lazy removal on authenticated presentation; unrelated-session preservation; generic/no-store response; exact matching-cookie clear; hash-absent expired replay without successor-cookie clearing; invalid-signature no-write behavior; restart persistence; browser fail-closed state; exact cleanup; and restoration of normal development configuration.

Not proven: automatic/background sweeping; cleanup of expired sessions that are never presented; cleanup without the required Origin/CSRF proof; early access-token revocation; established Socket.IO disconnection at expiry/logout; all-session logout; token-family compromise detection; multiple API replicas or clock-skew behavior; password reset, email verification, MFA/WebAuthn, or key rotation; public HTTPS/browser PKI; or a real remote browser. In isolation, a delayed request for a still-stored expired session can consume that hash and emit a clearing cookie after another tab has installed a different cookie. The later [cross-tab acceptance](production-auth-cross-tab-live.md) serializes supported two-tab Chromium/Web Locks mutations, but no-Web-Locks, legacy-client, crash, and broader browser/replica races remain outside that claim.
