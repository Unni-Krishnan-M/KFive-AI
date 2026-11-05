# Browser refresh-cookie and CSRF verification

Date: 2026-10-26  
Slice state: **Implemented bounded local browser critical path**  
Overall authentication state: **Experimental**  
Final disposable production-Compose nonce: `fb7dda12a7d9`

## Accepted contract

Browser login and registration explicitly request cookie transport. Production sets exactly one host-only `__Host-kfive-refresh` cookie with `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800` and no Domain. Browser JSON contains an access token and token-bound CSRF proof but no refresh token. Refresh and logout require the cookie-transport header, exact configured Origin, cookie, and current CSRF proof. Successful refresh atomically consumes the stored refresh hash and rotates the cookie and proof. Same-tab refresh callers share one rotation; logout fences the session, waits for an earlier rotation and uses its successor proof, then blocks later refresh starts and stale continuations. A stale valid predecessor gets 401 without a clearing cookie that could clobber a successor. Legacy non-browser JSON refresh tokens remain supported.

## TDD and automated gates

- Backend cookie/auth-policy focus: 2 suites / 8 tests passed, including base64url-only CSRF validation and a regression for ASCII-truncation aliases.
- Frontend lifecycle regressions first failed for duplicate direct/interceptor refresh, missing-CSRF 401 state, and failed-logout state loss. Independent re-review then found the inverse ordering where a late 401 could refresh after logout began. After epoch fencing, 2 files / 12 tests passed, covering both refresh/logout orders, shared single-flight, rotation-aware logout, retryable logout failure, unrecoverable-state clearing, and v1 persisted-refresh migration.
- Full frontend regression passed 22 files / 146 tests. Full backend regression passed 78 suites / 527 tests. Backend and frontend production builds passed; Vite retained its existing chunk-size advisory. Jest emitted its existing forced-worker-exit teardown warning after all assertions passed.
- All six production contract files and `git diff --check` passed. The auth contract includes an opt-in gate, exact cookie/header/replay/logout checks, protected-volume preservation, and diagnostic redaction for generated secrets, JWTs, cookie values, passwords, and private temporary paths.
- Final independent implementation, security, and evidence re-reviews returned GO for this bounded local Implemented claim and explicitly rejected any Complete or production-certified authentication claim.

## Disposable API/container acceptance

`npm run production:verify:auth` built nonce-tagged images and used an isolated production-Compose project:

| Contract | Result |
| --- | --- |
| Legacy JSON refresh | Session cap 10; concurrent reuse exactly `[200, 401]`; restart refresh and logout revocation passed |
| Browser cookie | Exact `__Host-kfive-refresh; HttpOnly; Secure; SameSite=Strict; Path=/`; seven-day max age; no Domain |
| Browser response | Refresh token absent from login and refresh JSON |
| CSRF/origin | Hostile Origin and missing CSRF returned 403; ambiguous body credential returned 400 |
| Rotation | Cookie and token-bound CSRF proof changed; predecessor replay returned 401 without clearing a possible successor |
| Restart | Current cookie/proof refreshed successfully after backend restart |
| Logout | Exact stored hash revoked; cookie cleared; no-cookie repeat was idempotent; revoked cookie returned 401 |
| Exposure | Frontend loopback edge only; API and datastores private |
| Cleanup | Project containers, networks, five owned volumes, and verifier images removed; every pre-existing `kfive-ai_*` volume identity unchanged |

## Post-fix real browser acceptance

A real browser used the rebuilt Compose frontend at `http://localhost:3002` and registered one disposable account. Cookie metadata—not its value—showed `__Host-kfive-refresh`, HttpOnly, Secure, Strict, path `/`, and browser host projection `localhost`; the server `Set-Cookie` has no Domain attribute. Persisted `kfive-auth` keys were exactly access token, CSRF proof, authentication state, and user; no refresh token was present.

Replacing the access token with an invalid fixture and reloading exercised StrictMode/bootstrap: one coherent cookie refresh recovered the dashboard and rotated the CSRF proof. This is recovery proof, not actual JWT-expiry proof. Restarting only the backend and reloading retained the session and rotated the proof again. The restart produced two transient Socket.IO console error entries for one failed 502 handshake, followed by reconnection; there were no persistent authentication errors. Sign out landed on `/login`, cleared the cookie, persisted only null user/access/CSRF values with `isAuthenticated: false`, and reload stayed on `/login`. Exact Mongo cleanup returned `{conversations: 0, users: 1, remaining: 0}`. After the final logout-epoch fix, a second browser smoke repeated register → no browser refresh token → logout → empty cookie list → signed-out reload with no console errors; its exact cleanup also returned one deleted user and zero remaining.

The development Docker daemon's known AppArmor defect prevents exec-based healthchecks, so Docker labels may say unhealthy even though frontend-proxied readiness and browser/API paths passed. No persistent volume was deleted.

## Claim boundary

Proven for this bounded local slice: removal of the seven-day refresh capability from browser-readable storage; exact secure cookie attributes; exact-Origin plus token-bound CSRF enforcement; atomic and same-tab single-flight rotation; same-tab logout/refresh epoch fencing; stale-response cookie safety; legacy-client compatibility; restart recovery; logout revocation/clear; legacy local-storage migration; real-browser recovery; private disposable topology; exact record/resource cleanup; and preservation of existing persistent volumes.

Not proven: XSS resistance. The short-lived access JWT and CSRF proof remain in `localStorage`, and active same-origin script can act as the user and invoke cookie refresh. The later [access-expiry acceptance](production-auth-expiry-live.md) proves natural HTTP expiry/browser recovery, [refresh-expiry acceptance](production-auth-refresh-expiry-live.md) proves lazy cleanup of a correctly presented expired session, and [cross-tab acceptance](production-auth-cross-tab-live.md) proves a bounded two-tab Chromium/Web Locks path, but not early access revocation or background sweeping. Public HTTPS/browser PKI, attacker-page preflight behavior, all-session logout, token-family theft detection, password reset, email verification, MFA/WebAuthn, signing-key rotation, no-Web-Locks/broader-browser behavior, multiple backend replicas, and a real remote browser remain incomplete. Overall JWT authentication and Phase 15 remain **Experimental**.
