# Access-JWT expiry and browser recovery verification

Date: 2026-10-26  
State: bounded local critical path **Implemented**; overall authentication and Phase 15 **Experimental**

## Accepted contract

Access and refresh JWTs now have explicit, separately verified token types. API and Socket.IO bearer authentication share a verifier constrained to the access signing key, HS256, issuer, audience, `type: access`, and cryptographic expiry. Production configuration requires distinct access and refresh signing keys. `JWT_EXPIRES_IN` accepts only a positive integer followed by `s`, `m`, `h`, or `d` and is bounded to 1 second–24 hours; `JWT_REFRESH_EXPIRES_IN` uses the same grammar and is bounded to 60 seconds–30 days.

Browser callers keep the refresh credential only in the secure host cookie established by the preceding cookie slice. Concurrent protected 401 responses share one refresh operation, rotate the access token and CSRF proof once, and retry using the successor access token. Logout revokes refresh state only: an already issued access JWT remains valid until its signed expiry.

## Automated verification

- TDD red phase: the new canonical-lifetime assertions in `backend/src/config/environment.test.ts` and access-vs-refresh type-confusion assertions in `backend/src/middleware/auth.test.ts` failed against the pre-change implementation. After validated lifetime configuration, explicit token typing, distinct-key enforcement, and the shared access verifier were implemented, the focused backend regression passed. The later concurrent-browser-401 test was added as regression coverage; it is not represented as a pre-implementation red test.
- Focused backend auth/config regression: 3 suites / 35 tests passed, including canonical duration bounds, distinct production signing keys, explicit access-token acceptance, and refresh-token rejection even when deliberately signed with the access key.
- Focused frontend session/transport regression: 2 files / 13 tests passed. The added two-request concurrency case observed exactly one cookie rotation, two successor retries, and one coherent persisted access/CSRF state.
- Full backend: 79 suites / 531 tests passed. Jest retained its existing forced-worker-exit warning after success.
- Full frontend: 22 files / 147 tests passed. A first full run executed concurrently with the backend suite and timed out only the five-second syntax-highlighting test; the isolated full rerun passed all 147 tests in 1.87 seconds.
- Frontend, backend, and Code Runner production builds passed. Vite retained its existing large-chunk warning.
- All six production contract files passed; development Compose configuration rendered successfully.
- `npm audit --omit=dev --audit-level=high` passed with 0 critical/high and the eight already tracked moderate findings in Tailwind/PostCSS, React Router, and BullMQ/UUID dependency paths.
- `git diff --check` passed after documentation and evidence updates.

## Disposable API/container acceptance

Final nonce: `cf101dbf7cc5`.

The isolated production-Compose verifier configured a four-second access lifetime, decoded the issued access JWT only to derive a capped wait, and asserted its type, issuer, audience, `iat`, `exp`, and exact four-second lifetime. The exact registered user profile succeeded before expiry. After natural cryptographic expiry, the same bearer token returned exact HTTP 401 with `Token expired`; cookie/Origin/CSRF refresh then rotated the session and the successor access token returned the same user profile.

Logout revoked the current refresh session. The access JWT issued immediately before logout continued to authenticate until its signed expiry, explicitly demonstrating the residual bearer window rather than claiming early revocation. The same JWT returned exact HTTP 401 after expiry. Generated secrets, JWTs, cookie values, passwords, and private temporary paths remained registered with the verifier redactor. Exact disposable records/resources were removed and all pre-existing persistent volume identities were preserved.

## Real-browser acceptance

A fresh browser registered `auth-expiry-20261026@example.invalid` through the running Compose frontend and received a four-second `type: access` JWT while browser storage contained no refresh token. After waiting for natural expiry without reloading, navigation to Projects produced this exact API sequence:

1. `GET /api/v1/projects?status=active` → 401
2. `POST /api/v1/auth/refresh` → 200
3. retried `GET /api/v1/projects?status=active` → 200

The Projects UI rendered authenticated, both access and CSRF values changed, and browser storage still had no refresh token. Reload returned to the authenticated Projects page. Sign out reached `/login`, persisted null user/access/CSRF state with `isAuthenticated: false`, and a further reload stayed signed out. The console contained one expected failed-resource 401 entry for the deliberately expired request and normal Socket.IO reconnect logs; no persistent authentication error remained.

Exact Mongo cleanup reported `{conversations: 0, users: 1, remaining: 0}`. The browser session was closed. The backend was then recreated without the temporary four-second override, and ordinary local readiness returned `ready` with MongoDB and Redis available. No persistent volume was removed.

## Boundaries

Proven here: validated lifetime configuration, explicit access/refresh separation, protection against refresh-as-bearer token confusion, natural HTTP access expiry, exact expiry response, automatic cookie recovery, concurrent-request single-flight rotation, retry with successor credentials, logout-until-expiry semantics, real-browser reload/logout behavior, exact cleanup, and restoration of the normal development configuration.

Not proven here: early access-token revocation or denylisting; all-session logout; token-family compromise detection; reset, email verification, MFA/WebAuthn, or key-rotation operations; XSS resistance; multiple API replicas; public HTTPS/browser PKI; a real remote browser; or live Socket.IO expiry/recovery. The later [refresh-expiry acceptance](production-auth-refresh-expiry-live.md) proves lazy cleanup of one correctly presented expired refresh session, while the later [cross-tab acceptance](production-auth-cross-tab-live.md) proves only a bounded two-tab Chromium/Web Locks path. Socket.IO uses the same tested verifier in code, but this run exercised expiry through HTTP only.
