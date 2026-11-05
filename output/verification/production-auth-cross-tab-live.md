# Cross-tab browser authentication acceptance — 2026-10-27

## Result and bounded claim

The same-origin two-tab Chromium path is **Implemented** when the browser provides Web Locks. One origin-wide exclusive lock serializes refresh, logout, and login/registration replacement. A canonical version-4 `localStorage` record carries a monotonic epoch, phase, and random per-login session identifier. Refresh followers may adopt a newer access/CSRF pair only when that session identifier is unchanged; a delayed request from an older login cannot be retried under a replacement account or session.

This is a local Docker Compose, two-tab Chromium/Web Locks result. Overall authentication and Phase 15 remain **Experimental**.

## Work board

| Owner | Scope | Acceptance criteria | Evidence | Merge gate |
| --- | --- | --- | --- | --- |
| Primary | Coordinator, Axios/Zustand integration, TDD, live browser, docs | One rotation for two tabs; refresh/logout ordering; no cross-session replay; logout convergence; exact cleanup | Focused/full tests, build, redacted browser request/state observations | All regressions green, ordinary config restored, diff check clean |
| Implementation reviewer | Coordinator/API/store diff | No stale-state or account-switch replay | File/line audit and focused tests | Independent GO |
| Security reviewer | Cookie/CSRF/lock/session threat boundary | No credential disclosure or cross-account retry; limitations explicit | Threat-model audit | Independent GO |
| Evidence reviewer | Tests, live observations, claim boundaries | Claims no broader than executed path | Evidence/doc audit | Independent GO |

## TDD and review-driven fixes

The initial coordinator tests passed refresh coalescing, both refresh/logout orderings, failed-logout rollback, and ambiguous-refresh fail-closed behavior. Independent review then found a release-blocking defect: an epoch/access mismatch was treated as a refresh successor even after logout/login replacement, so a delayed request from account A could have adopted account B's access token and retried its original operation.

Two regressions failed before the fix:

- the stale login-A refresh resolved with login-B credentials instead of rejecting;
- a malformed successful login/registration response left the earlier browser snapshot active instead of failing closed.

The fix added a cryptographically random, browser-local `sessionId` for every login/registration replacement. Refresh retains it; logout clears it; every protected request captures it; and an interceptor may adopt a refresh successor only when the identifier matches. A focused Axios regression proves a delayed protected request makes one attempt, performs no refresh, and is not retried after another account replaces the session. Invalid authentication responses now advance to signed-out state. A separate regression proves a stale lower-epoch Zustand persistence write cannot overwrite a newer canonical record.

A second independent implementation review found two additional stale-continuation defects. After the auth lock released, interceptor cleanup could sign out a newer login, and login/register/refresh/logout actions could perform redundant post-await credential writes at the newer epoch. RED tests reproduced both overwrites. Cleanup is now a lock-protected compare-and-sign-out against the request's exact epoch/session/access identity; redirect is conditional on the current state still being signed out. Zustand actions no longer write credentials after awaiting the coordinator, so coordinator subscriptions are the sole credential-state writer. A separate RED/GREEN contract removes the prior bearer from login/register requests.

The final focused suite passed 3 files / 26 tests. It includes the coordinator, Axios transport, auth-store, stale-continuation, bearer-omission, and active version-3 to version-4 migration contracts.

## Real browser execution

After the second review fixes, the rebuilt Compose frontend reran on 2026-10-27 against a temporary four-second access-JWT lifetime. The exact stopped development service containers were restarted over their preserved volumes; the known-failing notebook worker remained safely stopped. Real dependency readiness was `ready` with MongoDB and Redis available. A disposable account registered through the UI. Redacted state inspection proved:

- storage record version 4, active epoch 1, and a non-empty random session identifier;
- access JWT and token-bound CSRF proof present, with no refresh token field;
- Web Locks available;
- both same-origin tabs converged on the same user, epoch, session identifier, access token, and CSRF proof.

After natural access expiry, both tabs navigated concurrently to Projects. The observed API sequence was exactly one `POST /api/v1/auth/refresh` 200 followed by two `GET /api/v1/projects` 200 responses. No live protected 401 was observed because bootstrap coordination rotated before the page requests; this run therefore does not claim a live interceptor-401 race. Both tabs stayed active, retained the original session identifier, advanced to the same epoch, and held the same rotated access/CSRF values.

Signing out in one tab made exactly one `POST /api/v1/auth/logout` 200. Both tabs converged on version 4, epoch 5, `signed-out`, null session identifier, no user/access/CSRF values, and `/login`. The refresh cookie was absent. Reloading both tabs produced no authentication request and kept both on `/login`. The browser recorded zero console errors.

The exact disposable user count changed `1 -> 0`; it had no conversations. The browser session was closed. The backend was recreated without the temporary override, ordinary 15-minute access / seven-day refresh configuration was restored, and real readiness returned `ready`. No persistent volume was removed.

## Security and operational boundaries

Web Locks and `localStorage` coordinate trusted same-origin tabs; they are not a security boundary against XSS or a malicious same-origin service worker. The access JWT, CSRF proof, epoch, and session identifier remain browser-readable. The fallback used when Web Locks are unavailable is only same-tab serialization and is outside this claim. More than two tabs, other browsers, tab/process crashes, multi-replica APIs, clock skew, established Socket.IO behavior, public HTTPS, and a real remote browser were not tested.

If a refresh response installs the successor cookie and the owner tab dies before persisting the successor CSRF/state, recovery is fail-closed rather than crash-transparent. An ambiguous refresh response also signs all tabs out. A failed or ambiguous logout deliberately rolls back the browser snapshot for availability; server-side refresh state may already be revoked, while the access JWT remains usable until its signed expiry. A newer [backend replacement slice](production-auth-session-replacement-live.md) revokes the exact predecessor presented on successful login/registration replacement. All-session revocation, transactional cross-account replacement, and token-family compromise handling remain incomplete.

The live run proves two-tab refresh and logout convergence. Cross-session stale-request rejection, refresh-before-logout, logout-before-refresh, failed-logout rollback, invalid replacement fail-closed behavior, and lower-epoch anti-clobber behavior are focused deterministic tests rather than separately orchestrated live races.

## Verification gate

- Focused cross-tab/auth transport/store regressions: **26 passed**.
- Full frontend regression: **23 files / 160 tests passed**.
- Full backend regression: **80 suites / 534 tests passed**; Jest emitted its existing force-exit/open-handle advisory after the green run.
- Frontend production build: **passed**; the existing large-chunk advisory remains non-blocking.
- Backend production build: **passed**.
- Production static contracts: **6/6 passed**; restored Compose rendering validated.
- Current production dependency audit: **6 moderate, 0 high, 0 critical**; all available fixes require separately reviewed breaking changes.
- Live two-tab Chromium/Web Locks acceptance: **passed** within the boundary above.
- Exact account cleanup, browser closure, ordinary-config restoration, and real readiness: **passed**.

## Independent review outcomes

- Initial implementation review: **NO-GO**, finding cross-session stale-request replay; fixed with per-login lineage and coordinator/Axios regressions.
- Second implementation review: **NO-GO**, finding unlocked post-refresh cleanup and stale Zustand continuations; fixed with lock-protected compare-and-sign-out, conditional redirect, coordinator-only credential writes, and RED/GREEN regressions.
- Security review: **GO for this bounded local two-tab Chromium/Web Locks slice; NO-GO for production/remote authentication**. It retained the documented logout, displaced-refresh, crash, XSS/service-worker, and broader deployment limitations.
- Evidence review: **GO after recording explicit verdicts and corrected counts**. It confirmed the live/browser claims are separated from deterministic race tests and remain within the executed boundary.
- Final post-second-fix implementation re-review: **GO** with no blocking findings. Final security re-review: **GO** for the stated local two-tab Chromium/Web Locks boundary. Final evidence re-review: **GO** after the date, counts, explicit verdicts, and deployment wording were corrected. None of these verdicts certifies production or remote authentication.

