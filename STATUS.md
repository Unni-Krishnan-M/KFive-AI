# KFive AI Status

## 2026-11-13 Repository Analyzer dedicated Compose importer — Implemented slice / Experimental feature

Local and production Compose now run repository ZIP parsing in a dedicated `10001:10002` importer container over a fixed `0660` Unix socket. The backend receives only a read-only socket-volume mount plus group `10002`; the importer has `network_mode: none`, no application/data/secret/Docker-socket mounts, a read-only root, a 32 MiB no-exec tmpfs, all capabilities dropped, no-new-privileges, zero core dumps, a 48-PID/512 MiB/1-CPU ceiling, and a bounded one-shot parser child. Socket mode is explicit and has no process fallback. Importer absence reports an unavailable dependency, disables new analysis, returns fixed `503 REPOSITORY_ANALYZER_UNAVAILABLE`, and cannot persist a failed report; existing report read/list/delete paths remain available.

The real local frontend-proxy/API path passed valid persistence, encrypted rejection without persistence, importer SIGKILL, exact stale-socket recovery, unavailable status and fixed 503, offline reads of an existing report, parser-child observation only below the importer, backend/importer restart persistence, protected and ephemeral socket-volume identity preservation, fixed-field log non-disclosure, and exact two-user/report cleanup. The production dependency high introduced by Mongoose 8.24.6 was reproduced and removed with the narrow 8.24.7 patch; six moderate findings requiring breaking upgrades remain tracked. Compose exec healthchecks are reported unhealthy on this AppArmor host, so live UDS/API probes are the authoritative availability proof. See [live evidence](output/verification/repository-importer-container-live.md) and [security boundaries](docs/REPOSITORY_ANALYZER.md).

This slice is **Implemented for local and production Compose topology**, not Kubernetes or a complete production security certification. Repository Analyzer remains **Experimental** pending broader adversarial CPU/native-memory/concurrency measurements, stronger cross-field report consistency, Kubernetes importer isolation, distributed leases/quotas, and the planned adapters/intelligence features.

## 2026-11-06 Repository Analyzer child-process isolation — Implemented slice / Experimental feature

- Moved the production ZIP analyzer behind a one-shot Node child process while preserving the injected analyzer seam used by unit tests. Launch uses the fixed Node executable and worker path, `shell: false`, a fixed working directory, only `NODE_ENV=production`, 96 MiB V8 old space plus 8 MiB semi-space, a hard parent deadline, and a 4 MiB response ceiling.
- Added one exact binary request frame (version, bounded JSON metadata, raw archive bytes), a versioned success/error response, allowlisted error reconstruction, exact response-key/shape bounds, and source filename/MIME/byte/SHA-256 provenance checks before persistence. Crashes, spawn/stdin failures, malformed or oversized output, protocol errors, worker failures, and timeout paths return fixed safe errors; stderr is discarded.
- Review-driven TDD closed an observer lifecycle leak: listeners and the deadline are now armed before the verifier callback, and a throwing callback kills the child and resolves only after close. Focused coverage passed 3 suites / 57 tests; full backend passed 82 / 565.
- Compiled verification ran two valid analyses concurrently in distinct children, preserved the canonical encrypted-entry error in a third, advanced the parent heartbeat, matched direct analyzer results, and left zero children. The final Compose image passed authenticated multipart upload, Mongo persistence/retrieval, encrypted rejection without persistence, deletion, exact nonce-user cleanup, readiness, and six protected-volume identity checks.
- The exact image also ran two children as UID 1000 in a disposable network-none, read-only, capability-dropped, no-new-privileges, 32-PID, 256-MiB, one-CPU container with no mounts.

This slice is **Implemented process/event-loop/crash isolation**, not by itself a security sandbox. At this checkpoint the child still shared the backend container's UID, filesystem, process/network namespaces, and cgroup; the 2026-11-13 slice above subsequently moved it behind a dedicated non-root/network-disabled Compose importer boundary. V8 heap flags still do not bound all native memory. Repository Analyzer remains **Experimental** pending stronger cross-field report validation, broader target-host CPU/RAM/concurrency proof, and Kubernetes isolation. See [live evidence](output/verification/repository-importer-process-live.md) and [security boundaries](docs/REPOSITORY_ANALYZER.md).

## 2026-11-05 Repository Analyzer bounded ZIP end discovery — Experimental

- Replaced two independent ZIP end-of-central-directory scans with one shared inspector used for encryption detection and comment sanitization. It searches only the classic 65,557-byte tail window, considers at most eight structurally plausible candidates, and permits at most 2,001 cumulative central-header visits.
- The inspector requires checked single-disk count/offset/size arithmetic and exactly one fully validated classic EOCD. ZIP64 sentinels, multi-disk records, excessive candidates/work, and multiple coherent interpretations fail closed. Encryption remains rejected from both the selected central directory and the downstream entry path; ordinary comments, the maximum 65,535-byte comment, empty archives, and the existing 2,001-entry limit retain explicit regressions.
- RED reproduced the amplification: the 3.08 MiB / 65,534-header / 2,978-candidate shape spent about 24.0 seconds in the hostile test and exceeded its 10-second timeout. The deterministic regression now caps observable central-header reads, while the final built-code verifier rejected the full shape as `INVALID_REPOSITORY_ARCHIVE` in 0.356 ms with 0.381 ms zero-delay timer lag under a 250 ms host ceiling.

This closed the identified synchronous end-record amplification and split-interpretation defect. At that checkpoint ZIP parsing still shared the backend process; the 2026-11-06 and 2026-11-13 slices above subsequently added bounded child-process availability isolation and a dedicated Compose importer boundary. Repository Analyzer remains **Experimental** because target-host CPU/RAM/concurrency coverage is not comprehensive, cross-field validation remains bounded rather than exhaustive, and Kubernetes isolation has not passed. See [live evidence](output/verification/repository-archive-end-record-live.md) and [security boundaries](docs/REPOSITORY_ANALYZER.md).

## 2026-11-05 Repository Analyzer retained-history pagination — Experimental

- Workspace, exact-project, and deleted-project recovery history now return strict 50-item pages with scope-specific totals and a maximum of ten pages. Stable `createdAt DESC, _id DESC` ordering and matching compound indexes make equal-timestamp records deterministic; list responses remain bounded summaries and preserve the existing `analyses` plus page-local `count` fields.
- Page input is canonical and bounded: omitted means page 1; zero, signs, leading zeroes, fractions, repeated parameters, values above ten, and pages beyond the current scope's last page return 400. The frontend rejects inconsistent pagination envelopes, invalidates stale detail requests during navigation, and retreats one page after deletion of the final visible item.
- Disposable nonce `dc11e01d5654` exercised 100 equal-timestamp reports through real API and browser paths. Both pages passed in workspace, project, and orphan scopes; a second owner saw zero; page 2 opened report 049 in Chrome with no console errors. Exact cleanup left zero matching reports/projects/users, and the six pre-existing KFive named volumes retained their identities.
- The merge security gate detected newly published high-severity advisories in `follow-redirects` 1.16.1 and Joi 17.13.8. Compatible lockfile upgrades to 1.16.2 and 17.13.9 cleared all production critical/high findings; six previously bounded moderate findings still require separately reviewed breaking upgrades.

This closed the retained-history visibility gap. The later bounded-end-discovery, child-process, and dedicated Compose importer slices removed the identified central-directory candidate amplification and added availability plus container isolation; broader target-host CPU/native-memory proof, Kubernetes isolation, and stronger semantic consistency remain critical work. Repository Analyzer remains **Experimental**. See [live evidence](output/verification/repository-pagination-live.md) and [design/security boundaries](docs/REPOSITORY_ANALYZER.md).

## 2026-10-27 presented refresh-session replacement — Experimental

- Cookie-mode login and registration now treat the browser's current refresh cookie as the exact predecessor session. After credentials and request validation succeed, the backend verifies that capability, removes its stored SHA-256 hash before appending the successor, and publishes the successor cookie only after both datastore operations succeed.
- Review-driven TDD started with two failing replacement contracts and now covers same-account and cross-account ordering, failed credentials/duplicate registration, correctly signed expired predecessors, datastore failure, bad signatures, malformed cookies, and unchanged legacy JSON behavior. The focused auth gate passes 4 suites / 21 tests.
- Disposable production-Compose nonce `8ee783fa1adb` proved same-account login and cross-account registration replacement against MongoDB: each predecessor count became zero, each successor count was one, an unrelated sentinel session remained one, predecessor replays returned 401 without clearing the successor cookie, and the successor refreshed successfully. Exact cleanup and protected-volume preservation passed.

This bounded presented-predecessor path is **Implemented**; overall authentication and Phase 15 remain **Experimental**. Cross-account revoke/append is not transactional on standalone MongoDB, and a stolen-token rotation that wins before the exact pull can leave another valid successor. All-session/token-family revocation, early access revocation, background sweeping, account-reset/MFA/key-rotation flows, broader browsers, multi-replica races, and remote acceptance remain incomplete. See [live evidence](output/verification/production-auth-session-replacement-live.md).

## 2026-10-27 cross-tab browser authentication coordination — Experimental

- Browser refresh, logout, and login/registration replacement now share one origin-wide Web Lock and a canonical version-4 persisted record. A monotonic epoch/phase prevents stale state writes, while a random per-login session identifier allows refresh followers to adopt only a successor from the same login session.
- Review-driven TDD found and fixed a cross-account replay defect: a delayed request from account A could otherwise adopt account B's access token after session replacement. A second review found that post-lock interceptor cleanup and post-await Zustand writes could erase or corrupt a newer login; compare-and-sign-out now runs under the auth lock, redirects are conditional, and coordinator subscriptions are the sole credential-state writer. Login/register also omit the prior bearer token.
- Coordinator and Axios regressions prove stale requests perform no refresh/retry as another account, stale failures/continuations preserve a newer session, invalid authentication responses fail closed, and lower-epoch Zustand writes cannot clobber newer state. The focused gate passes 3 files / 26 tests, including active version-3 to version-4 migration; the full frontend passes 23 files / 160 tests.
- One real logout 200 moved both tabs to the same signed-out epoch and `/login`, removed the refresh cookie, and both reloads made no authentication request. Console errors were zero. The disposable account was removed exactly, the browser closed, ordinary 15m/7d lifetimes were restored, and readiness returned green without removing a volume.

This bounded local two-tab Chromium/Web Locks path is **Implemented**; overall authentication and Phase 15 remain **Experimental**. The no-Web-Locks fallback is same-tab only. Same-origin XSS/service workers, more tabs/browsers, tab death between `Set-Cookie` and state persistence, multi-replica/remote behavior, live Socket.IO expiry, early access revocation, all-session/token-family revocation, background sweeping, reset/verification/MFA, and key rotation remain incomplete. A newer backend slice revokes the exact predecessor presented during successful browser replacement; failed/ambiguous logout still rolls browser state back even though server revocation may already have succeeded. See [cross-tab evidence](output/verification/production-auth-cross-tab-live.md) and [replacement evidence](output/verification/production-auth-session-replacement-live.md).

## 2026-10-26 expired refresh-session cleanup — Experimental

- A correctly signed expired refresh JWT is now removed lazily by an atomic hash-exact Mongo `$pull` when it is presented with the required cookie transport, exact Origin, and token-bound CSRF proof. The response remains generic and no-store. The matching browser cookie is cleared only when that mutation actually consumed the stored hash.
- TDD exposed and fixed the hash-absent stale-response case: an expired predecessor whose hash had already rotated away previously emitted a clearing cookie that could overwrite a successor. It now returns 401 without `Set-Cookie`; malformed/bad-signature tokens cause no session write. Focused route/policy/config/auth tests pass 5 suites / 42 tests.
- Disposable production-Compose nonce `590c580edbff` used the minimum valid 60-second refresh lifetime. It proved the exact signed lifetime, target-hash presence before and after natural expiry but before use, exact removal on the expired request, preservation of an unrelated sentinel session, idempotent replay without cookie clearing, no mutation for a bad signature, restart persistence, exact cleanup, and protected-volume preservation.
- A real browser used a 15-minute access JWT and 60-second refresh JWT. Projects still loaded after refresh expiry, proving access remained valid. Reload then made exactly one refresh request, received 401, cleared the HttpOnly cookie and local auth state, reached `/login`, and a second reload made no refresh attempt. The expected refresh 401 was the only console error. Mongo session count changed from one to zero; the disposable account was removed and ordinary 15m/7d development readiness was restored.

This bounded local presented-session cleanup path is **Implemented**; overall authentication and Phase 15 remain **Experimental**. It is lazy cleanup of one correctly presented expired session, not background sweeping or cleanup without valid Origin/CSRF. The newer [two-tab Chromium/Web Locks slice](output/verification/production-auth-cross-tab-live.md) serializes supported-browser mutations, but no-Web-Locks, legacy-client, crash, and broader browser/replica races remain outside that claim. Early access revocation, established-Socket expiry, all-session logout, token-family compromise handling, reset/email verification/MFA, key rotation, multi-replica behavior, clock-skew matrices, and a real remote browser also remain incomplete. See [live evidence](output/verification/production-auth-refresh-expiry-live.md).

## 2026-10-26 access-JWT expiry and browser recovery — Experimental

- Access JWTs now carry an explicit `type: access` claim and are accepted only with the configured access key, issuer, audience, HS256 algorithm, and expiry. Refresh JWTs remain `type: refresh`; production validation requires distinct access and refresh signing keys, closing refresh-as-bearer confusion even if a token is presented to HTTP or Socket.IO authentication.
- `JWT_EXPIRES_IN` and `JWT_REFRESH_EXPIRES_IN` use a canonical positive integer plus `s`, `m`, `h`, or `d`. Access lifetime is bounded to 1 second–24 hours and refresh lifetime to 60 seconds–30 days. The production environment preflight and both Compose manifests enforce/pass these values.
- Disposable production-Compose nonce `cf101dbf7cc5` issued a four-second access JWT, proved the declared cryptographic lifetime, accepted it before expiry, rejected it naturally with exact `401 Token expired`, recovered through one cookie/CSRF rotation, and accepted the successor. Logout revoked refresh but deliberately did not revoke the already issued access token; that token remained valid only until its signed expiry and was then rejected. Exact cleanup and persistent-volume preservation passed.
- A real browser waited for natural expiry, navigated to Projects, observed one protected 401, one refresh 200, and one successful retry. Access and CSRF values rotated, no refresh token entered browser storage, reload remained authenticated, and sign-out plus reload remained signed out. The browser console recorded the expected 401 resource error from the deliberate expiry test; no persistent authentication failure remained. The disposable account was removed exactly and the normal development lifetime configuration was restored.

This bounded local expiry/recovery critical path is **Implemented**; overall authentication and Phase 15 remain **Experimental**. Access JWTs are not revoked early on logout, the access JWT and non-secret CSRF proof remain browser-readable, and the later refresh-expiry slice proves only lazy cleanup of a correctly presented expired session. A newer bounded two-tab Chromium/Web Locks path is also Implemented, but background sweeping, all-session logout, token-family detection, reset/email verification/MFA, key rotation, no-Web-Locks/broader-browser/multi-replica behavior, live Socket.IO expiry, and a real remote browser remain incomplete. See [live evidence](output/verification/production-auth-expiry-live.md).

## 2026-10-26 browser refresh-cookie and CSRF transport — Experimental

- Browser login and registration now put the seven-day refresh credential in an exact `__Host-kfive-refresh` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/`, no Domain) and return only the access JWT plus a token-bound CSRF proof to JavaScript. Legacy JSON refresh tokens remain available to explicit non-browser clients.
- Cookie refresh and logout require the explicit cookie transport header, an exact allowed `Origin`, the cookie, and the current HMAC-derived CSRF proof. Refresh retains MongoDB compare-and-swap rotation, rotates both cookie and CSRF proof, and rejects predecessor replay without clearing a newer cookie. Same-tab bootstrap/interceptor refreshes are single-flight; a logout epoch waits for an earlier rotation and blocks later refresh starts and stale continuations.
- Final disposable production-Compose nonce `fb7dda12a7d9` passed the legacy and cookie API contracts after concurrency, stale-response, CSRF-validation, and diagnostic-redaction fixes, with exact resource cleanup and preservation of all known persistent volume identities.
- A post-fix real browser registered through the Compose frontend, proved no refresh token in `localStorage`, recovered coherently after an invalid access-token fixture and backend restart, then signed out, cleared the cookie, and stayed signed out after reload. Two transient Socket.IO errors occurred during the intentional backend restart and recovered; no persistent authentication error remained. The disposable account was removed exactly.

The bounded local browser refresh-cookie critical path is **Implemented**; overall authentication remains **Experimental**. The short-lived access JWT and non-secret CSRF proof still reside in `localStorage`; active XSS can act as the user and invoke same-origin refresh. Later slices prove natural access expiry/recovery, presented expired-session cleanup, and two-tab Chromium/Web Locks coordination, but not early access revocation. All-session logout, token families, reset/email verification/MFA, key rotation, no-Web-Locks/broader-browser/multi-replica and real remote-browser matrices remain incomplete. See [live evidence](output/verification/production-auth-cookie-live.md).

## 2026-10-25 production TLS/domain edge acceptance — Experimental

- Added a create-new, mode-0600 TLS configuration renderer that validates the full production environment, exact HTTPS origin/DNS-shaped hostname, regular non-symlink certificate/key paths, private-key permissions, SAN/key match, current validity, and at least seven days of remaining certificate validity.
- The operator-managed Nginx template uses only the fixed validated origin for redirects, rejects unknown HTTP hosts and TLS SNI, limits TLS to 1.2/1.3, disables tickets, emits one bounded HSTS/header policy, preserves streaming/Upgrade behavior, and replaces rather than extends untrusted forwarding state.
- Disposable nonce `0e4f5acb3002` passed strict private-CA/hostname TLS, hostile Host/SNI rejection, exact CORS, authenticated provider discovery and structural SSE, forwarding-spoof rate limiting (`401` five times then `429`), same-container backend/proxy restart, Mongo chat persistence, unchanged volume identities, hardened edge-only topology, explicit external readiness supervision, exact record/resource cleanup, and preservation of all pre-existing volume identities.

This is an **Experimental same-host TLS/proxy protocol proof**. It does not prove public DNS, a publicly trusted certificate, ACME issuance/renewal, browser PKI, Internet/WAN behavior, a clean remote host, a real external provider, or laptop independence. See [TLS operations](docs/TLS.md) and [live evidence](output/verification/production-tls-live.md).

## 2026-10-25 production Compose hybrid acceptance — Experimental

- A nonce-isolated production-Compose run used local MongoDB/Redis/ChromaDB and five local persistent volumes with an independently managed, authenticated OpenAI-compatible protocol fixture attached only to provider egress. Runtime reported `hybrid`, classified the provider `remote`, classified all three stores `local`, and exposed no addresses or generated secrets.
- Structurally parsed SSE proved the exact remote marker and provider/model. Stopping the exact fixture produced 503 model discovery and a durable zero-output `CHAT_PROVIDER_UNAVAILABLE` result with no start/delta or Ollama provider event. Restarting the same container restored inference.
- MongoDB/backend restart preserved the user, conversation success/failure history, Hybrid classification, post-restart inference, and all five volume identities. Only frontend published a loopback port; all other services and the hardened external fixture published none.
- Exact database record cleanup and ownership-gated container/network/volume/image cleanup passed. Every pre-existing Docker volume identity remained unchanged. Final post-security-review live nonce: `fe1b34161855`.

This is an **Experimental same-host Hybrid protocol cell**, not a remote-host, hostile-tenant, real-provider, TLS/WAN, cross-host persistence, provider-governance, multi-replica, or laptop-independence proof. See the [acceptance matrix](docs/DEPLOYMENT_ACCEPTANCE_MATRIX.md) and [live evidence](output/verification/production-hybrid-live.md).

## 2026-10-25 production authenticated-read floor — Experimental

- A disposable production-Compose project executed 24 excluded warmups followed by exactly 240 authenticated `GET /api/v1/user/profile` requests through the loopback frontend at concurrency 12 with keep-alive. Every response returned HTTP 200, the registered user ID/email, and no password or refresh-token fields. Prometheus success, all-status, and duration-count deltas were exactly 240.
- Final nonce `343f5e35553b` recorded p50 23.21 ms, p95 29.98 ms, p99 31.56 ms, maximum 34.78 ms, and 495.47 requests/second, passing predeclared p95 ≤750 ms, p99 ≤1,500 ms, and throughput ≥20 requests/second floors. Backend process RSS grew 4,853,760 bytes and heap used grew 3,410,880 bytes; both snapshot growth and absolute ceilings passed.
- The backend remained running without OOM under its enforced 1-GiB/2-CPU/192-PID, read-only, capability-dropped limits. Two burst-adjacent Docker samples observed at most 88,436,899.84 bytes and 12 PIDs; these are sampled values, not instantaneous peaks, and CPU samples are observational only.
- Backend restart then passed dependency readiness, login returned the same user ID, and an authenticated profile read succeeded. All five disposable volume identities remained unchanged; exact cleanup removed project resources and verifier-labelled images while preserving the six known `kfive-ai_*` volume identities.

This is an **Experimental single-host, single-user, warm-cache authenticated Mongo-read burst floor**, not a production SLO or sizing result. It excludes sustained/cold-cache and mixed workloads, writes, uploads, queues, AI/streaming/GPU, multi-user fairness, multiple replicas, TLS/WAN/remote-host behavior, failover, and horizontal scaling. The disposable backend raised its request limit to 1000; default production throttling was not load-tested. [Detailed evidence](output/verification/production-performance-live.md).

## 2026-10-24 authentication and dependency hardening — Experimental

- Passwords are constrained to 8–72 UTF-8 bytes at route, model, and comparison boundaries so bcrypt cannot silently accept distinct over-limit inputs. Access and refresh inputs are bounded before cryptographic parsing, issued JWTs have unique IDs, and malformed/untrusted refresh tokens do not cause database writes.
- Registration and login atomically retain at most ten hashed refresh sessions. Refresh rotation verifies refresh-only claims and uses a MongoDB compare-and-swap update, making a stored refresh token one-use when requests race. Logout atomically revokes the supplied refresh token.
- Disposable production-Compose acceptance nonce `d413b7c4f4fc` rejected a 74-byte password without persisting its account, capped registration plus twelve logins at ten sessions, rejected an evicted oldest login token, returned exactly one 200 and one 401 for simultaneous reuse, refreshed the winner after a backend restart, then returned 401 after logout. Exact fixture cleanup passed and known `kfive-ai_*` volume identities were unchanged.
- Exact Axios 1.18.0 → 1.20.0 and Multer 2.2.0 → 2.5.0 upgrades plus compatible lockfile resolutions reduced `npm audit --omit=dev` from 2 high / 8 moderate to 0 high / 8 moderate (0 critical). The eight remaining moderate findings are in Tailwind/PostCSS, React Router, and BullMQ/UUID paths and require separately reviewed range/major changes.

This is the historical bounded **Experimental backend/API session slice**, not complete authentication or production certification. Its browser cookie/CSRF, natural access-JWT expiry/recovery, and presented expired-refresh cleanup gaps are addressed by newer 2026-10-26 implementations above. Early access revocation, background expired-session sweeping, reset/email verification/MFA, all-session or token-family revocation, key rotation, multi-replica/remote behavior remain unproved. Existing accounts whose passwords exceed 72 UTF-8 bytes require a reset. [Historical evidence](output/verification/production-auth-live.md).

## 2026-10-24 production Compose backup/restore — Experimental

- Added trusted-host, maintenance-mode `production:backup` and create-new-only `production:restore` commands for one coherent application set: a logical gzip MongoDB archive plus quiesced Redis persistence, ChromaDB storage, and uploads. Secrets and logs are excluded.
- The private versioned bundle records exact artifact sizes/SHA-256 hashes and datastore images. Restore stages artifacts from no-follow descriptors, bounds artifact/member/expanded sizes, rejects unsafe paths and non-regular archive entries, requires a different empty Compose project and prefix, post-verifies unique volume ownership, and rolls back only its token-labelled new volumes on failure.
- A disposable two-project drill destroyed the exact source volumes, restored into fresh volumes, and recovered the same account, exact dataset bytes, Redis state, and a raw Chroma record before and after datastore/backend restarts. Corruption failed before mutation; a foreign sentinel was preserved; known `kfive-ai_*` volume identities were unchanged; cleanup left no fixture objects.

This is an **Experimental** offline, same-host/same-datastore-image recovery path—not hot backup, signed/encrypted off-host retention, cross-version migration, remote DR, Kubernetes/observability recovery, RAG relationship proof, or queued-work replay safety. Review restored Redis queues before starting workers. [Detailed evidence](output/verification/production-backup-restore-live.md).

## 2026-10-24 local-kind NetworkPolicies — Experimental

- Added default-deny ingress/egress to both application and observability namespaces, with explicit edges for the loopback Traefik routes, frontend/backend, private datastores, Prometheus, Grafana, Loki, Alertmanager, the fixed subsystem prober, Fluent Bit, and the separately opt-in Datadog output.
- DNS is limited to CoreDNS selectors and the pinned `10.96.0.10/32` Service address. Fluent Bit now derives bounded pod/container identity from log tags with `Use_Tag_For_Meta On`; it has no Kubernetes API token, ServiceAccount, Role, or RoleBinding.
- The hardened live verifier used healthy canaries in both namespaces and a foreign namespace. It denied all nine private targets three times per canary with explicit remote denial sentinels and heartbeat checks, while declared edge, datastore, scrape, dashboard, log, and alert paths remained functional. Cleanup removed every canary and preserved the application Secret UID and all PVC UIDs.
- Independent review found and fixed two verifier false-positive/cleanup defects: denial probes no longer treat `kubectl exec` failures as policy success, and Alertmanager cleanup explicitly removes its temporary Secret mount before deleting the Secret. Datadog verification now correlates path, marker, credential, and gzip in one delivery and asserts exact collector restoration.
- Post-review Datadog, Loki, alerting, static manifest, and Kubernetes API dry-run regressions passed. The disposable-cluster result and boundaries are recorded in [the NetworkPolicy evidence](output/verification/network-policies-live.md).

This is a single-node kindnet proof, not production or tenant isolation. Label selectors can be impersonated by principals that may create/relabel pods, Traefik remains intentionally reachable at the edge, and the opt-in Datadog policy permits collector TCP/443 to any destination because standard NetworkPolicy cannot select an FQDN. Remote/multi-node CNI proof, FQDN-aware egress, Kubernetes/observability recovery, broader security/performance review, and the real remote-host/provider acceptance cell remain Planned; the newer bounded same-host Hybrid cell is recorded above. Phase 15 is therefore **Experimental**.

## 2026-10-22 production Compose foundation — Experimental

- Added a standalone six-service production topology for frontend, backend, benchmark worker, MongoDB, Redis, and ChromaDB. Only the frontend publishes a host port, bound to loopback by default; application and data networks are internal, while provider egress is separated from the edge.
- Added fail-closed preflight for a private mode-0600 environment file. It requires an explicit remote/hybrid mode, HTTPS public origin and CORS entries, an authenticated HTTPS remote provider, distinct non-placeholder JWT secrets, URL-safe datastore credentials, and digest-pinned images.
- Added stable named volumes, bounded resources/PIDs/log rotation, restart policies, a database-scoped Mongo `readWrite` application user, non-root application images, read-only application filesystems, dropped capabilities, `no-new-privileges`, and an operator script that validates, renders, pulls, starts with health gates, and never removes data.
- TDD contracts cover invalid/valid configuration, topology, host-port boundaries, persistence names, service limits, and lifecycle safety. An isolated acceptance overlay uses a private authenticated OpenAI-compatible fixture and no host Ollama dependency.
- A real browser traversed frontend proxy → authenticated API → provider discovery → streaming chat and received `REMOTE_PROVIDER_VERIFIED`. MongoDB/backend restart retained the account. A complete container/network teardown without `-v`, followed by recreation over the same five named volumes, returned the identical user id. This proves Mongo identity persistence and volume-object preservation, not written-data recovery for Redis, ChromaDB, uploads, or logs. The exact disposable conversation/user and all test volumes were then removed.
- Live acceptance found and fixed an edge-network defect: a frontend attached only to an internal network had a configured port binding that Docker could not publish. The verified manifest now attaches only the frontend to a separate non-internal edge network.
- Compatible lockfile refreshes and exact Axios/Multer upgrades removed the production tree's critical/high findings. The current `npm audit --omit=dev` result is 8 moderate, 0 high, and 0 critical; Tailwind/PostCSS, React Router, and BullMQ/UUID paths remain explicit follow-up work, so this is not a clean-security claim.
- Independent merge-gate review caught an ignored production template, overly narrow proxy trust, overwritten HTTPS forwarding, and incomplete Docker context exclusions. TDD contracts now keep the safe template trackable while excluding private `.env.*` files from build contexts; production requires the exact outer TLS proxy → frontend → backend two-hop chain, while the HTTP-only acceptance harness explicitly uses one hop.

This is a bounded **Experimental foundation**, not completed remote deployment. That historical acceptance used local mutable images/internal HTTP and did not prove immutable registry artifacts, a real provider tenant, remote host, DNS/TLS, recovery, migration, failover, or laptop independence. The separate 2026-10-24 slice above later proved only same-host/same-datastore-image application recovery. The host Docker daemon also failed every exec-based healthcheck because AppArmor profile application returned `operation not permitted`; real HTTP/auth/provider paths ran, but target-host health-gated startup must be rerun on a functioning daemon. [Detailed evidence](output/verification/production-compose-live.md).

## 2026-09-30 independent subsystem reachability — Experimental

- Added a dependency-free, fixed-target prober for MongoDB TCP, Redis TCP, and ChromaDB's HTTP heartbeat. It accepts no target or query input, follows no redirects, exposes no credentials or raw diagnostics, and emits exactly three fixed-cardinality success series from a private ClusterIP service.
- Added a private Prometheus scrape, the `KFiveSubsystemUnavailable` rule with a 30-second hold, and an **Independent subsystem probes** Grafana panel. The hardened tokenless pod is non-root, read-only, capability-dropped, seccomp-constrained, probe-covered, and resource-bounded.
- A disposable-kind lifecycle scaled only ChromaDB to zero, observed only the Chroma probe fail and the alert fire, restored ChromaDB, observed all three probes recover and the alert clear, and retained the ChromaDB PVC UID. Public access to prober metrics was denied and the application health route recovered.
- Real Chrome rendered MongoDB, Redis, and ChromaDB as **Available** with zero firing alerts. All Prometheus and Loki datasource calls returned 200; the only console error was Grafana's known anonymous-user star request returning 401.

This proves shallow, independent local reachability and one subsystem alert lifecycle, not authentication-aware transactions, datastore correctness/performance, provider or worker health, or remote monitoring. NetworkPolicy isolation was absent in this historical run and is superseded by the 2026-10-24 local-kind slice above. Observability remains **Experimental**. [Detailed evidence](output/verification/subsystem-probes-live.md).

## 2026-09-30 private Alertmanager notification delivery — Experimental

- Added Alertmanager 0.29.0 to the opt-in local-kind observability overlay. Prometheus targets only its private ClusterIP service; Alertmanager has no Traefik route, Ingress, Kubernetes API token, RBAC, or gossip listener.
- The committed configuration has a bounded 24-hour state claim and a null receiver, so the default profile performs no outbound notification egress. The pod is non-root, read-only, capability-dropped, seccomp-constrained, probe-covered, and resource-bounded.
- A disposable verifier refuses non-baseline or pre-existing harness state, creates a private hardened receiver with a generated bearer credential in a transient Secret, and temporarily routes only `KFiveBackendUnavailable` to its exact in-cluster address.
- Live acceptance held Alertmanager offline while the backend rule fired, restored it, received the authenticated firing notification, restored the backend, and received the resolved notification with the same fingerprint. It then restored the exact null configuration, removed every receiver resource, retained the Alertmanager PVC UID, and reconfirmed the healthy backend and inactive rule.
- The Prometheus/Grafana restart-persistence verifier passed with Alertmanager enabled, followed by a second full firing/resolved delivery run.

This proves local Alertmanager outage recovery and authenticated protocol delivery to a private test receiver. It does not configure a real pager, email/chat receiver, TLS, escalation, inhibition/silence policy, remote monitoring, or production on-call acceptance. NetworkPolicy isolation was absent in this historical run and is superseded by the 2026-10-24 local-kind slice above. Observability remains **Experimental**. [Detailed evidence](output/verification/alertmanager-live.md).

## 2026-09-30 bounded subsystem and GPU telemetry — Experimental

- Added fixed-cardinality backend-process availability metrics for MongoDB and Redis plus cached, single-flight GPU probing. Scrapes remain successful when GPU probing fails; unavailable states use a fixed reason and device count zero while per-device VRAM/utilization/temperature series are omitted.
- Available GPU samples are validated and capped at eight numeric indices. Names, UUIDs, drivers, raw messages, errors, users, projects, runs, URLs, and credentials are never metric labels or values.
- Closed a confidentiality defect found by the independent security audit: HTTP metric and request-log paths now use static mount allowlists plus matched route templates. All 404s collapse to `/not-found`, unsafe/unmatched shapes collapse to `/unknown`, and raw path/query values no longer enter Prometheus or ordinary request/error logs.
- Added **Subsystem availability**, **GPU probe availability**, **GPU VRAM utilization**, and **GPU temperature** panels. A fresh disposable-kind run proved MongoDB/Redis at 1, CPU-only backend GPU unavailability with `nvidia-smi-not-found`, no fabricated per-device series, private `/metrics`, and Prometheus/Grafana restart persistence.
- Real headless Chrome rendered both dependency states as **Available**, the GPU probe as **Unavailable**, and VRAM/temperature as **No data**. All datasource queries returned 200; the only console error was the known anonymous Grafana star request returning 401.

This is backend-process telemetry, not deep datastore or queue metrics and not physical GPU acceptance. Independent Chroma reachability and one subsystem rule are covered by the newer slice above; provider/worker reachability, queue depth/latency, kube-state metrics, DCGM/device runtime wiring, a controlled GPU workload, broader alerts, and remote monitoring remain Planned. Observability remains **Experimental**. [Detailed evidence](output/verification/subsystem-gpu-metrics-live.md).

## 2026-09-30 optional secret-backed Datadog log forwarding — Experimental

- Added a separately opt-in `k8s/observability-datadog` overlay. The default observability profile remains Loki-only and has no Datadog Secret dependency.
- The opt-in collector reads `DD_API_KEY` from the externally created `kfive-datadog` Secret, uses TLS and gzip for the real Datadog intake, retains the existing Loki sink, and bounds retries plus queued storage. No credential is committed or rendered into a ConfigMap.
- Added `kind:up:datadog`, which validates a private `.env` key and creates the Secret from a mode-0600 temporary file without printing it. The live verifier refuses to replace any pre-existing Secret or receiver resource.
- A disposable-kind private-receiver run proved authenticated gzip delivery to `/api/v2/logs`, dual delivery of the same structured marker to Loki, ClusterIP-only receiver exposure, and unconditional restoration of the default collector. The current tokenless collector has no Kubernetes API credential or RBAC with which to read the Secret. A sentinel run also proved the pre-existing Secret UID remained unchanged on refusal.
- Teardown testing exposed Docker-daemon restart recreating the still-mounted socket directory as an empty host-root mode-0755 path. A red/green lifecycle regression keeps normal validated cleanup before node deletion, refuses every foreign state, and permits only an exact owned-node/read-only-mount recovery before removing that exact empty orphan.

This proves the collector contract without sending logs to an external service. No real Datadog tenant, account acceptance, retention, billing, regional endpoint, legal/privacy policy, or remote-cluster path was tested. The slice and overall observability remain **Experimental**. [Detailed evidence](output/verification/datadog-live.md).

## 2026-09-29 local alert evaluation and dashboard visibility — Experimental

- Added a Prometheus `KFiveBackendUnavailable` rule with a 30-second hold, critical/component labels, operator annotations, and coverage for both a failed scrape and a missing/stale target series.
- Added a scoped **Firing alerts** Grafana stat panel. Prometheus remains ClusterIP-only; the browser reaches alert state only through the existing loopback Grafana datasource proxy.
- A disposable-kind verifier loaded the healthy rule, safely scaled only the backend deployment to zero, observed the alert firing, restored the backend in an unconditional cleanup path, observed the rule return inactive, and confirmed the application health route recovered.
- The existing Prometheus/Grafana restart-persistence gate passed after the change. A real headless Chrome session rendered all four dashboard panels and the recovered alert count of zero; datasource calls returned 200 and the only console error was the known anonymous Viewer star request returning 401.

This slice proves local rule evaluation and dashboard visibility, not notification delivery. Alertmanager, receivers/escalation, inhibition/silencing policy, notification retry/deduplication, SLO burn-rate rules, subsystem/GPU rules, remote monitoring, and production on-call acceptance remain Planned. Observability remains **Experimental**. [Detailed evidence](output/verification/alerting-live.md).

## 2026-09-28 restart-persistent searchable local logging — Experimental

- Added private single-binary Loki 3.7.8 with TSDB v13/filesystem storage on a protected 2 GiB claim, 24-hour compactor retention, bounded ingestion/line/query settings, disabled analytics and automatic label discovery, and a tokenless hardened pod.
- Fluent Bit now sends only `kfive` namespace records to Loki with the fixed low-cardinality `job`, `namespace`, and `container` labels. The current collector derives namespace, pod, container, and Docker id from the log tag and has no Kubernetes API token or RBAC; this supersedes the original pod-only Role design.
- A clean disposable-kind verifier proved structured marker search through Grafana, unchanged PVC identity and historical search after Loki restart, buffered delivery across a temporary Loki outage, resumed collection after Fluent Bit replacement, private ClusterIP-only exposure, and absence of authorization/query canaries after later backend and Traefik ingestion watermarks.
- The canary exposed Traefik retaining raw query strings in `RequestPath`; a failing manifest contract now requires that access-log field to be dropped. Backend logs retain normalized paths without query strings.
- A real Chromium session rendered the bounded 100-line **KFive application logs** panel alongside both metrics panels. An initial 1,000-line/5-second panel caused Grafana OOM kills; the verified 100-line/10-second panel plus 192/768 MiB request/limit completed sustained refreshes with zero restarts. The only console error was the known anonymous Viewer star request returning 401.
- Final regressions passed the logging persistence/outage gate, Prometheus/Grafana restart persistence, and the authenticated frontend/Socket.IO/model/Phi3 chat/bridge/Mongo core verifier.

This is **restart-persistent searchable local logging**, not production durability. Kind deletion, node/PV loss, backup/restore, multi-replica Loki, authenticated tenant isolation, TLS, secure erasure, hard byte-based retention, remote storage, and remote-cluster proof remain unverified. Local-kind NetworkPolicies were verified separately on 2026-10-24. Observability stays **Experimental**. [Detailed evidence](output/verification/loki-live.md).

## 2026-09-24 local-kind Argo CD GitOps — Experimental

- Added a pinned and SHA-256-verified Argo CD 3.5.3 bootstrap plus separate, non-overlapping infrastructure and application `Application` resources. AppProjects restrict the exact repository, cluster, namespaces, and resource kinds and blacklist Secret management.
- A disposable private Git server supplied an isolated snapshot at an exact commit without exposing a host port or copying the working tree's `.git` metadata. Infrastructure synchronized first with automated self-heal and pruning disabled; application resources synchronized second with self-heal and bounded pruning enabled.
- A clean live kind run proved exact-revision sync, application canary creation/pruning, replica self-heal, application-controller and repository-server restart recovery, and a final `Synced/Healthy` state. Five PVC UIDs and the externally created Secret UID/content hash remained unchanged.
- Replaced Traefik's Kubernetes provider and cluster-wide API access with tokenless static file-provider routes. Live frontend/readiness routing and the authenticated Socket.IO/model/chat/restart/persistence core verifier passed through the Argo-managed cluster.
- Focused results passed: GitOps contracts 6/6, Kubernetes contracts 5/5, observability contracts 4/4, Bash/Node syntax, both Kustomize renders, and `git diff --check`. The opt-in observability overlay was then reapplied to the Argo-managed cluster; Prometheus/Grafana restart persistence and Fluent Bit structured parsing/restart collection passed with the tokenless static routes.

Argo CD is **Experimental**, not Complete. The verified scope is a disposable single-node local-kind profile using a private temporary Git source. Remote Git credentials, remote or multi-node clusters, production TLS/SSO/RBAC, controller isolation, immutable application image digests, disaster recovery, and promotion/rollback policy remain unverified. [Detailed evidence](output/verification/argocd-live.md).

## 2026-09-23 local-kind observability — Experimental

- Added an opt-in `kfive-observability` overlay with pinned Prometheus 3.14.0 and Grafana 13.2.2, private services, persistent claims, bounded retention/resources, probes, non-root/read-only security contexts, a private backend scrape, and one provisioned two-panel KFive dashboard.
- Added bounded backend HTTP/process metrics. Query parameters and authorization values are excluded, normalized path series have a fixed overflow cap, and public `/metrics` remains routed to frontend HTML rather than the internal exporter.
- Fixed cross-namespace Traefik discovery and Grafana 13.2 immutable startup behavior. Plugin auto-updates and administration are disabled; the bundled Prometheus datasource registered and queried successfully without writable image paths.
- The full opt-in kind lifecycle exited 0. The live verifier passed Prometheus target/query checks, retained an exact historical sample across Prometheus restart, retained non-provisioned Grafana PVC state across Grafana restart, and revalidated the datasource/dashboard after both restarts.
- A real Chromium session rendered **KFive Overview**, **Backend request rate**, and **Backend resident memory** through Traefik with zero `No data` panels; both Prometheus panel queries returned HTTP 200. The anonymous Viewer session's optional star request returned a benign 401.
- The original slice added Fluent Bit 5.1.2 with namespace-scoped pod-only RBAC, nested JSON parsing, Kubernetes metadata, bounded ephemeral buffering, read-only host log mounts, and local stdout output. That historical backend/Traefik marker, scope-denial, exposure, and collector-replacement acceptance passed; the current collector is tokenless and tag-derived as documented above.
- Focused results: observability manifests 4/4, Kubernetes manifests 5/5, backend app 5/5, backend build, Bash syntax, Kustomize rendering, and `git diff --check` passed.

This 2026-09-23 slice established metrics and local log parsing. Later slices supersede its stdout-only logging, collector RBAC, alerting, broader telemetry, Datadog, and NetworkPolicy limitations. Real Datadog SaaS acceptance, production-durable remote storage, TLS, and remote monitoring remain Planned. [Detailed evidence](output/verification/observability-live.md).

## 2026-09-23 Code Lab critical re-verification — Complete

- Fixed and regression-tested the terminal cancellation/Mongo reconciliation race: a completed BullMQ result remains eligible for Mongo reconciliation instead of being overwritten during cancellation.
- Unified the real queue configuration across the API producer, heartbeat/cancellation client, worker, and worker health check. A live split configuration kept general Redis on database 0 and placed the heartbeat/job/result only in queue database 1.
- A production browser execution and active UI cancellation passed through frontend/API → Redis → worker → disposable Docker runtime → MongoDB. Exact run IDs, outputs, HTTP results, Redis/Mongo checks, cleanup, and the zero-error browser console check are recorded in [the acceptance evidence](output/verification/code-lab-critical-live-2026-09-23.md).
- Restarted both API and worker; browser reload and history detail retained the successful and cancelled records unchanged.
- Focused results: backend 38/38, worker 30/30, frontend Code Lab 5/5; backend/worker builds and `git diff --check` passed.

The supported Python/JavaScript Code Lab path remains **Complete**. This does not expand the claim to additional languages, immutable runtime-image digests, or public multi-tenant certification.

## 2026-09-22 local kind core — Experimental

- Added the `kfive`/`kfive-observability` namespaces and bounded manifests for MongoDB, Redis, ChromaDB, backend, frontend, Traefik, private services, persistent claims, ConfigMaps, external Secret injection, probes, resources, labels, and non-root/read-only security contexts.
- Replaced the firewall-blocked host TCP bridge with a route-allowlisted Unix-socket bridge. The socket path has no TCP Service/EndpointSlice, rejects symlinks/foreign ownership and unsafe cleanup, validates the exact read-only kind bind mount, and survived a real bridge restart from the backend pod.
- A clean live run passed frontend/readiness routing, Socket.IO polling, registration, authenticated model discovery, real `phi3:latest` streaming, bridge restart, MongoDB/backend restart, same-id login persistence, and exact fixture cleanup. Six pods were Ready and five PVCs Bound.
- Focused regressions passed: 3 socket-directory lifecycle tests, 5 rendered-manifest/script contracts, 12 bridge tests, Bash syntax, Kustomize rendering, and the independent live verifier.

Kubernetes/Traefik are now **Experimental**, not Complete. The original browser tool could not resolve `kfive.local` because the documented local host mapping was absent, so that run made no kind application-browser-rendering claim. Code/document/AI workers, GPU access, TLS, portable storage and backup, multi-node/remote operation, and broader feature persistence remain unverified or Planned. Default-deny local-kind policies were verified later on 2026-10-24; observability and Argo CD have separate bounded Experimental slices. [Detailed evidence](output/verification/kind-core-live.md).

## 2026-09-21 Workflow production acceptance — Implemented single-replica fixed-text slice

- Fixed terminal cancellation versus delayed Mongo reconciliation, case-normalized run identifiers/leases, provider timeout classification, startup orphan recovery, canonical timeline ordering, non-buffered SSE, and UI polling to the terminal server state.
- The UI now exposes **Cancel run** only after SSE supplies the durable run id; before that it shows disabled **Starting…**. New definitions exclude embedding-only models.
- Real production-browser run `6ab1681ddd440a87811252d5` succeeded through local Ollama and persisted output `WORKFLOW_SUCCESS_92126`. Run `6ab16837dd440a87811252e9` was cancelled through the real UI with the ordered `created → started → cancel requested → cancelled` timeline.
- Final redeployed-edge run `6ab16f5940f6fd4df740509d` visibly transitioned **Starting… → Cancel run → cancelled**. After restarting the backend, the browser recovered that exact Mongo-backed run id/status. Exact cleanup removed its disposable run, workflow, and user and confirmed zero residual records.
- Focused verification passed: 4 backend suites / 33 tests, 4 frontend files / 18 tests, backend and frontend production builds, deployed frontend health, and real browser cancellation/restart persistence. An independent read-only blocker audit returned PASS.

The local workspace-scoped single-replica fixed `Input → Prompt → LLM → Output` path is **Implemented**. Overall Workflows remain **Experimental** because general nodes, project/archive and second-owner live acceptance, distributed coordination, remote providers, Kubernetes, and live bound testing remain incomplete. [Detailed evidence](output/verification/workflow-live.md).

## 2026-09-21 Agent Runtime production acceptance — Implemented single-replica slice

- Fixed terminal cancellation versus delayed Mongo reconciliation, case-normalized execution leases/identifiers, provider timeout classification, startup orphan recovery, ordered timelines, non-buffered SSE proxying, and UI polling to the canonical terminal cancellation state.
- Fixed Agent model selection so embedding-only models cannot be selected for new chat runs; new Agents safely use the validated provider default unless the user explicitly selects a chat-capable model.
- A real production browser run `6ab16197859c35a0c874ac4a` streamed through the authenticated proxy and local Ollama, persisted as `succeeded`, and returned exactly `BROWSER_AGENT_SUCCESS_92126`. A second real UI run `6ab161e3859c35a0c874ac7c` was cancelled with the **Cancel run** control and persisted the ordered `created → started → cancel requested → cancelled` timeline.
- After restarting the backend, a fresh browser reload reopened both exact Mongo-backed history records and the successful output. All disposable runs and the Agent were then deleted through the UI; exact Mongo cleanup removed the one test user and confirmed zero residual Agents/runs/users for that fixture.
- Focused verification passed: 5 backend suites / 37 tests, 4 frontend files / 21 tests, backend and frontend production builds, deployed frontend health, and the real browser run/cancel/restart path.

The verified local single-replica Agent Runtime path is **Implemented**. Overall Agents remain **Experimental**: tools and approvals are deliberately absent, execution/cancellation coordination and retention admission are process-local, and distributed/remote/Kubernetes paths are not verified. [Detailed evidence](output/verification/agent-live.md).

## 2026-09-21 stored PDF/OCR to Knowledge/RAG — Experimental

- Added an owner-scoped, idempotent `POST /api/v1/knowledge/sources/from-document` path and an **Add to Knowledge** action for completed stored PDF/PNG/JPEG documents. The browser sends only `documentId`; the backend derives identity, project scope, content, page count, and OCR provenance from MongoDB. A unique partial index prevents duplicate sources for the same owner/document.
- Reliable form-feed page boundaries are preserved in Chroma metadata and returned as page references. Mismatched boundaries fail safely without invented page numbers. Retrieved owner/scope/source/document/page metadata is checked against MongoDB before use.
- The real production path passed: browser/API → isolated PDF/OCR processor → MongoDB document → Ollama embeddings → ChromaDB → Ollama answer → page-aware result. The live API verifier also passed repeat-ingestion idempotency, second-owner denial, and cleanup.
- After restarting MongoDB, ChromaDB, the document processor, and backend, all services became healthy and a real browser query returned HTTP 200 with `ORCHID PAGE TWO 92126` and `page 2`. The temporary source/vector and document were then deleted.
- Focused checks passed: 4 backend suites / 49 tests, 2 frontend files / 17 tests, backend/frontend production builds, backend/frontend image builds, and the live verifier.

Knowledge/RAG remains **Experimental**. Indexing is synchronous and capped at 64 KiB/64 chunks; there is no crash-recovery worker, pagination/quota, reindex control, reranking, DOCX/repository ingestion, or remote/Kubernetes proof. A Knowledge source is an independent snapshot and must be deleted separately from its originating Document. [Detailed evidence](output/verification/document-rag-live.md).

## 2026-09-21 isolated OCR ingestion — Experimental

- Added bounded English OCR for validated PNG/JPEG images and text-empty scanned PDFs through the opt-in Document Processor. The backend streams stored bytes to the separately configurable `OCR_SERVICE_URL`, persists text/page count plus an `ocrApplied` marker in MongoDB, and exposes the text only through the owner-scoped detail route.
- Tesseract and Poppler run outside the API process with fixed executable arguments. Images are signature/dimension/pixel checked; scanned PDFs are metadata/encryption/page checked and rendered one page at a time. Input, raster, page, output, timeout, and single-job limits apply, and per-job temporary files are removed.
- Live API verification passed a 1,681,857-byte PNG, JPEG, and raster-only PDF through the production port-3002 proxy, processor/Tesseract/Poppler, and MongoDB, including second-user denial and cleanup. A real production browser PNG upload displayed `KFIVE BROWSER OCR 92126`; after restarting backend and processor, browser reload displayed the same Mongo-backed OCR result.
- Focused verification passed: 11 processor tests with 96.80% line, 80.95% branch, and 88.89% function coverage; 30 backend document/config tests; 4 frontend transport/Nginx tests; backend/frontend production builds; processor/backend/frontend image builds; and the deployed live verifier. The production Nginx config was inspected with its 52 MiB multipart allowance and bounded 95-second upstream timeouts. Container inspection confirmed UID 1000, read-only root, 512 MiB RAM, 1 CPU, 64 PIDs, no published port, internal-only networking, Tesseract 5.3.0, and empty processor temp state.

This is an OCR ingestion slice, not completion of Document Studio. It is synchronous, English-only, and limited to one processor job, 25 MiB inputs, 25 PDF pages, 25 million image pixels/10,000 pixels per side, and 1 MiB extracted text. The bounded stored-document-to-RAG path above now consumes persisted OCR text, but searchable PDF output, queues/progress/cancel/crash recovery, batch OCR, broader document AI, and authenticated/TLS remote OCR remain Planned or unverified. The browser acceptance document/account remain as restart-persistence evidence. [Detailed evidence](output/verification/ocr-live.md).

## 2026-09-20 isolated PDF text extraction — Experimental

- Added an opt-in, separately containerized PDF text processor. The backend streams only validated PDFs to its fixed `/extract` contract; Poppler runs outside the API process with a non-root user, read-only root filesystem, isolated 64 MiB tmpfs, no published port, an internal-only Compose network, and CPU/RAM/PID/time/page/input/text limits.
- PDF uploads persist owner/project-scoped extracted text and page count. List responses omit text and storage details; an owner-scoped detail endpoint supplies text only for completed records. Project state is revalidated under the shared mutation lease before an upload is published.
- Live API verification passed upload → processor → Poppler → Mongo detail/list → deletion. A real production browser upload displayed the exact extracted marker, then displayed it again after restarting both backend and processor and reloading the UI.
- Fixed the production Nginx proxy retaining a removed backend container address: API and Socket.IO targets now re-resolve through Docker DNS. After deploying the fix, backend replacement without frontend restart retained proxy access and the complete extraction verifier passed again.
- Relevant checks: 4 processor tests passed; 26 backend document/config tests passed; the focused Nginx regression passed; backend/frontend production builds and all three Docker images passed before deployment. Actual container inspection confirmed non-root/read-only/384 MiB/32 PID/no-host-port settings and empty processor temp state after extraction.

This is a verified PDF text-extraction slice, not completion of Document Studio. The newer bounded OCR ingestion and stored-document-to-RAG slices are Experimental; searchable scanned-PDF output, conversion/compression, preview/thumbnails, batch processing, and broader document AI remain Planned. The browser acceptance document and dedicated test account are retained as persistence evidence. [Detailed evidence](output/verification/document-extraction-live.md).

## 2026-09-20 Code Lab critical acceptance — Complete

The currently supported Python/JavaScript execution path is **Complete** against the requested critical acceptance checks. This supersedes its Experimental critical-path status below; additional languages and broader master-platform features are not included in this claim.

- Fixed terminal cancellation versus delayed Mongo reconciliation; regression verifies the successful output survives cancellation and subsequent reconciliation.
- Unified BullMQ and heartbeat/cancellation Redis selection (`QUEUE_REDIS_URL` then `REDIS_URL`), including worker health check and Compose configuration.
- Production browser run `6aaf711cc2305ff93acf6541`: HTTP 202, succeeded, stdout `CODE-LAB-E2E:persist-20260920`, exit 0. Redis worker result and Mongo record matched.
- Production UI Stop on active run `6aaf7141c2305ff93acf655f`: HTTP 200, cancelled, captured `CANCEL-STARTED`; Redis and Mongo matched.
- Restarted production `backend` and `code-runner`; browser reload returned HTTP 200 history and reopened both saved outputs/statuses unchanged.
- Relevant regressions: 38 backend tests passed across codeRunService, codeRunReconciler, redis, queues; runner Redis configuration/healthcheck test files passed; backend and runner builds passed. Existing container isolation tests were not duplicated for this acceptance slice.

Deployment remains opt-in via `--with-code-lab`; it is currently enabled locally. The dedicated acceptance account and its three test runs remain available as verification records. This is not a public multi-tenant security certification.

## 2026-09-19 Code Lab queue integration verification

- Re-ran runner unit tests and all eleven disposable-container scenarios successfully.
- Added and executed `scripts/verify-code-queue-live.cjs`: real Redis/BullMQ dispatch to the runner and Docker succeeded; queue result survived a graceful worker restart; cancellation propagated and cleaned up. Disposable Redis was removed; application services/data were untouched.
- This historical queue-only check did not prove authenticated API/browser or MongoDB history behavior and identified a terminal-cancellation reconciliation race plus split Redis configuration. Both findings and the missing critical-path verification were resolved by the 2026-09-20 acceptance entry above. [Queue evidence](output/verification/code-queue-live.md).

## 2026-09-19 Code Lab runner live verification

- Fixed read-only-rootfs source delivery without host mounts or weakening isolation; bounded source arguments feed fixed Python/JavaScript bootstraps. Native stdin and main-module behavior were verified in actual containers.
- Eleven live scenarios passed: Python input, module semantics, Unicode/chunking; JavaScript input/module semantics; stderr/exit status; timeout; output limit; OOM; filesystem/network/identity isolation; process pressure; cancellation. Actual resource configuration and executor cleanup were checked per scenario.
- Runner build/lint and 29 unit tests passed in this historical source-only slice. The later 2026-09-20 acceptance completed authenticated browser-to-queue/history execution and restart persistence; immutable runtime pinning and broader languages remain follow-up scope. Deployment stays default-disabled. [Evidence](output/verification/code-runner-source-delivery.tdd.md).

## 2026-09-18 PDF duplication deployment

- Frontend-only rebuild/deployment passed; the healthy container serves the exact browser-tested PDF bundle. Proxied readiness and service-worker artifact checks passed, with existing persistent volumes preserved.
- Duplicate Pages is Implemented as a browser-local structural operation. Rechecked 24 PDF tests and coverage thresholds passed; wider Document Studio remains Experimental.
- Open `http://127.0.0.1:3002/app/files?tool=duplicate`. Select pages to add one adjacent copy of each; repeated selections add no additional copies. Historical pending-deployment notes below are superseded. [Evidence](output/verification/pdf-duplicate.tdd.md).

## 2026-09-18 PDF duplicate browser verification

- Isolated production preview passed invalid-page rejection/recovery and a real Blob download for `3,1,1`. Independent reopening verified six pages in order `1,1,2,3,3,4` with preserved dimensions/rotations. No user records or PDFs changed; browser session was synthetic and API traffic blocked.
- Added `scripts/verify-pdf-duplicate-output.cjs`. Deployment remains pending; the operation stays Experimental. [Evidence](output/verification/pdf-duplicate.tdd.md).

## 2026-09-18 PDF duplicate source slice — Experimental

- Added Duplicate Pages to the source utility and command palette: one adjacent copy per selected page, original untouched, duplicates in the selection ignored, 500 output pages maximum.
- TDD RED/GREEN executed: four new failures for missing implementation, then 24 PDF tests passed. PDF utility coverage: 87.97% lines/statements, 85.89% branches, 100% functions. Browser download verification and deployment remain pending. [Evidence](output/verification/pdf-duplicate.tdd.md).
- Full frontend regression: 129 tests passed; production build and lint passed. Run `npm run test:pdf --workspace frontend` to reproduce PDF coverage verification.

## 2026-09-18 PDF reorder deployment

- Frontend-only Compose rebuild succeeded. The healthy deployed frontend's PDF bundle SHA-256 matches the browser-tested artifact exactly; served worker files match the local build and proxied API readiness passes. Preserved existing data volumes.
- Expression-based Reorder Pages is now Implemented as a browser-local structural utility. Document Studio remains Experimental; thumbnails/drag reorder and isolated processing are not implemented. Recheck passed all 20 PDF tests and coverage thresholds.
- Open **PDF Utilities → Reorder Pages** at `http://127.0.0.1:3002/app/files?tool=reorder`; include every source page once. Historical pending-deployment entries below are superseded by this result. [Evidence](output/verification/pdf-reorder.tdd.md).

## 2026-09-18 PDF reorder browser verification

- Isolated production-preview browser passed missing/duplicate rejection, recovery and real Blob download. Independent reopening confirmed four pages in order `4,2,1,3`, dimensions/rotations and unchanged source geometry. Synthetic browser-only session with blocked API traffic; not an authentication/backend E2E test.
- Added `scripts/verify-pdf-reorder-output.cjs` for generated-fixture/output verification. The narrow local reorder path is verified; container deployment remains pending, so the source operation stays Experimental for now. [Evidence](output/verification/pdf-reorder.tdd.md).

## 2026-09-17 PDF reorder slice — Experimental

- Added strict page reordering in the PDF utilities and command palette: every page must appear exactly once; output is a new download. Existing extract/rotate/delete selection behavior is preserved.
- TDD: three new tests failed for missing implementation, then all 20 PDF tests passed. Generated output was reopened to verify order, rotation and unchanged input bytes. PDF utility coverage passes 80% thresholds; all 125 frontend tests passed.
- Browser download E2E and deployment remain pending, so this operation is not marked Implemented. Thumbnails and drag reordering remain planned. See [evidence](output/verification/pdf-reorder.tdd.md).
- Frontend production compilation and lint passed. Verification commands: `npm run test:pdf --workspace frontend`, `npm run test --workspace frontend`, `npm run build:frontend`, `npm run lint:frontend`.

## 2026-09-17 security follow-up

- Axios deployment follow-up: rebuilt and started frontend/backend with the host-Ollama override and preserved volumes. All six baseline containers are healthy; deployed backend resolves Axios 1.18.0 and readiness returns HTTP 200. Served worker artifacts match the tested local build. Read-only browser smoke loaded landing and login pages with zero console errors/warnings (an autocomplete advisory remains). This does not verify authenticated Chat/upload journeys or unconfigured Code Runner/Document Processor/OCR services.

- Axios runtime update: frontend/backend now pin 1.18.0; current root audit is **38 findings / 0 critical / 17 high**, with no Axios finding. Added real HTTP provider streaming/cancellation regression and frontend auth-refresh/multipart transport tests; 21 provider tests and 122 frontend tests passed. Container rebuild and browser regressions for this update remain pending.
- Final Axios verification: full backend **73 suites / 487 tests passed**; all three production builds and root lint passed. New transport tests exercise real loopback HTTP for provider streaming and controlled adapters for frontend requests, not full browser E2E.

- Root tooling follow-up: locked `concurrently -> shell-quote` updated to 1.10.0; three targeted regression/smoke tests passed and are included in root `npm test`. Full-root audit now reports **39 findings / 0 critical** (18 high, 19 moderate, 2 low). This supersedes the historical critical count for the current source dependency graph, not existing container images. No full-platform security or completion claim.
- Verification rerun: full root test command passed (710 passed, 3 notebook integration cases skipped); all three production builds and root lint passed. Backend parallel Jest emitted a worker teardown warning; frontend build retains a large Chat chunk warning.
- Backend serial open-handle diagnostic subsequently passed all 486 tests with no handle report after allowing temporary local socket binding; the initial sandbox-only `EPERM` failure is documented in the triage report. Parallel teardown warning was not reproduced, not claimed fixed.

- Deployment follow-up: frontend-only Compose build succeeded; HTTP worker-artifact verification passed against the tested local build. Existing stopped services were restored using preserved volumes. Legacy cache migration takes effect when the new worker activates. Broader container-build audit reports 30 findings / 1 critical, distinct from the frontend-scoped audit below; further triage remains required.

- Frontend-scoped npm audit reduced from 32 findings / 2 critical to **29 findings / 0 critical** after matched Vitest/coverage updates and scoped nested Prism correction. **17 high findings remain**; no clean-security claim.
- Removed authenticated remote API response caching and added a legacy-cache migration that preserves unrelated caches. Real preview-browser activation verified cleanup using synthetic entries; no real user cache data was used in testing.
- **120 frontend tests passed**, lint/build passed, PDF coverage thresholds passed. Remaining dependency remediation and post-deployment Chat/auth/upload browser regression checks are pending. See [triage and evidence](docs/SECURITY_TRIAGE_2026-09-17.md).

## 2026-09-17 PDF deletion slice

- Follow-up frontend-only Docker build/deployment succeeded and the container is healthy. Deployed PDF bundle SHA-256 matches the production-preview browser-tested artifact exactly. Delete Pages is now Implemented as a structural browser utility; Document Studio remains Experimental. The build reported 33 dependency advisories (2 low, 11 moderate, 17 high, 3 critical), requiring separate reachability/version triage; no production-security certification is implied.

- Coverage follow-up resolved the missing plugin with a version-matched development dependency and lockfile update. `npm run test:pdf --workspace frontend` passes 17 tests and enforced 80% thresholds (90.25% lines/statements, 85.4% branches, 100% functions for the PDF utility only). Full frontend regression: **112 tests passed**; lint passed. The preceding missing-plugin limitation below is historical.

- Added Delete Pages utility and command-palette entry. The new PDF preserves retained-page order/rotation and does not overwrite the original. All-page deletion is rejected; UI starts with an empty selection and warns this is not secure redaction.
- Executed RED/GREEN tests using generated PDFs and reopened outputs. Frontend production build and lint passed. Production-preview browser download was independently reopened and verified (two retained pages, correct dimensions/order/rotation, original four-page fixture preserved). Coverage measurement is blocked by missing `@vitest/coverage-v8`; no coverage claim. Docker deployment remains pending after npm download timeout; the original frontend container was restored and disposable QA accounts removed. See [TDD evidence](output/verification/pdf-delete.tdd.md).

## 2026-09-17 host Ollama connection

- **Live browser RAG passed:** registration, TXT selection/indexing, ready 384-dimensional embeddings, correct cited answer/source excerpt, source survival after reload, unknown response for absent information, and fixture deletion. Independent Mongo/Chroma checks confirmed zero fixture sources/vectors; the disposable account was removed. [Evidence and limits](output/verification/rag-browser-2026-09-17.md). PDF/OCR ingestion, GPU and remote operation remain unverified by this test.

- Added opt-in Linux Compose bridge using a restricted Unix socket, with no new TCP listener or changes to host Ollama binding. Backend and workers retain normal container networking. See [setup and security boundary](docs/OLLAMA_HOST_BRIDGE.md).
- Executed model listing, real `all-minilm:22m` embeddings (384 dimensions), and completed streamed `phi3:latest` inference from the deployed backend through the bridge. Ollama remained bound to `127.0.0.1:11434`; bridge inspection confirmed UID/GID 1000, read-only root filesystem, dropped capabilities and 96 MiB limit.
- Backend verification: **72 suites / 486 tests passed**; build and lint passed. Bridge: **11 tests passed**, including output bounds, disconnect cancellation, request limits, redirect denial and concurrency release. Bridge tests now participate in root `npm test`.
- Configured this host's installed `all-minilm:22m` embedding model explicitly in its ignored `.env`. No credentials or existing data were changed. These results do not establish GPU use, remote deployment, or browser ingestion/query completion.
- Follow-up restart: Docker Hub DNS timed out during rebuild. Existing verified images started successfully with preserved volumes; backend provider health/model listing and embedding configuration passed after restart. Added and executed `scripts/kfive-up.sh --with-host-ollama --no-build` for local-image startup. This is not a successful fresh rebuild claim.

## 2026-09-16 RAG lifecycle follow-up

- Real standalone loopback API integration passed with host Ollama `all-minilm:22m` (384-dimensional embeddings) and `phi3:latest`: correct cited answer, refusal to invent missing information, source references, owner/project boundaries, archive guards, Mongo reconnect/server reopen persistence, recovery, and vector cleanup. `scripts/verify-rag-live.cjs --allow-live-test` reproduces it using isolated fixtures. Those fixtures were removed; the small embedding model remains installed. This is not production Compose routing, browser inference, GPU, or process-crash proof.
- Fixed mixed-case ObjectId divergence between MongoDB and case-sensitive vector metadata/collection hashes.
- Recheck project state under the shared in-process mutation lease before creating indexing metadata and publishing ready sources. Archive/delete during indexing triggers cleanup and failed metadata instead of ready publication.
- Indexing-source deletion now returns a structured `409 RAG_SOURCE_BUSY`; refreshed server archive state controls the Knowledge page's mutation buttons and banner.
- Added owner-scoped deleted-project knowledge recovery with fail-closed scope validation, read-only recovery UI, and vector-before-metadata deletion. A live synthetic-fixture browser/API/MongoDB/ChromaDB test passed archive protection, recovery discovery, second-user rejection, full stop/start persistence, and selected-owner deletion preserving another owner's vectors. Disposable accounts and fixture data were removed; this is not an AI ingestion/query test.
- Chat choices now exclude explicitly non-chat models while retaining unknown legacy metadata. Smart routing explains when a reported preference does not support chat instead of claiming it is absent.
- Verification: backend **71 suites / 468 tests passed**, frontend **18 files / 107 tests passed**, all lint targets passed, and frontend/backend production Compose builds and startup passed. Automated lifecycle regressions use controlled provider/vector implementations; they do not prove live embeddings or distributed concurrency safety.
- Normal deployment diagnosis: embedding model configuration remains unset; the backend's configured Ollama connection failed, while host Ollama was active on loopback only. No deployment AI/network configuration was changed. Production browser/Compose ingestion-query E2E, pagination/quotas, and indexing crash reconciliation remain outstanding. See [RAG](docs/RAG.md).

The dated baseline below records the preceding verification run, not updated totals for this follow-up.

Documentation updated: 2026-09-15. Phase 9, Phase 10, and Phase 11 source verification plus live local Notebook Mode, Chat durability, Project Rooms, browser PDF, Dataset Lab, Model Benchmark, and Repository Analyzer slices are included below; remaining gaps stay explicit.

## Phase 0 result

The initial repository was not operational: both production builds failed, both test commands had zero tests, lint had no configuration, four backend models were missing, production alias resolution was broken, Compose referenced missing build files, and documentation claimed unverified production readiness. The full evidence is in [docs/AUDIT_PHASE_0.md](docs/AUDIT_PHASE_0.md).

## Phase 1 stabilization result

Completed in this slice:

- Restored frontend and backend builds.
- Added User, Conversation, Document, and Agent models.
- Added typed local/hybrid/remote environment validation and canonical `MONGODB_URL` support.
- Added shared AI provider selection with explicit no-fallback errors; Ollama was the initial adapter and Phase 2 records the current provider set.
- Added request IDs, exact CORS allowlisting, liveness, readiness, and dependency-specific states.
- Fixed Redis/BullMQ URL handling and graceful queue/database shutdown paths.
- Added owner scoping to chat/agent HTTP and Socket.IO paths.
- Hashed stored refresh tokens and constrained JWT verification.
- Replaced shell command construction in document conversion with argument-array execution and time/output limits.
- Fixed frontend API contracts, same-origin routing, SSE fragmentation, false health indicators, and fabricated voice responses.
- Removed the unsafe Code Studio route from the shipped UI.
- Rebuilt Compose and Dockerfiles around non-root multi-stage images and explicit secrets.
- Added guarded local lifecycle scripts.

## Verification

| Command/check | Result |
| --- | --- |
| Production builds | Passed: frontend/backend Compose builds and Code Runner TypeScript build |
| Test-script components, executed separately on 2026-09-15 | Passed: 617 checks plus 3 intentional image-only skips (101 frontend across 18 files, 445 backend across 71 suites using `npm test -- --runInBand`, 6 Code Runner, 65 passed/3 skipped notebook-runtime checks); not a single root `npm test` invocation |
| `npm run lint` | Passed |
| `bash -n setup.sh scripts/*.sh test-auth.sh` | Passed |
| `docker compose --env-file .env.example config --quiet` | Passed |
| Production backend module load | Passed with test environment |
| `npm audit` (rerun 2026-10-24) | 32 total advisories remain: 4 critical, 13 high, 13 moderate, 2 low; production-only results are recorded separately below, so this is not a clean-tooling claim |
| `npm audit --omit=dev` (rerun 2026-10-24) | 8 production-tree advisories remain: 0 high, 8 moderate, 0 critical; advertised fixes require separately reviewed dependency-range or major changes |
| Docker image build | Passed on the user host for frontend, backend, benchmark/notebook workers, and both notebook image targets; the image test stage runs all 68 runtime checks |
| Local Compose health/persistence | Frontend, backend, MongoDB, Redis, ChromaDB, and benchmark worker rebuilt and started; Notebook run/history, Chat timeout/Stop records, Project/document/Dataset data, a completed Benchmark, and Repository Analyzer reports passed restart/reload persistence checks |
| GPU access | Failed capability check; driver unavailable to this environment |

## Known limitations

The Notebook Mode authenticated MongoDB/Redis/Docker path is live-verified through both its API and real browser UI. Chat's strict input boundary, provider-timeout persistence, explicit Stop/cancellation, safe terminal messages, provider/model/latency display, and Mongo-backed reload path also passed in a real browser. The Project Room core lifecycle, second-user ownership boundary, project-document archive/restore behavior, restart persistence, and guarded deletion passed against the production Compose frontend/backend/MongoDB path. All three currently exposed browser PDF operations produced downloaded files whose bytes were independently reopened and checked. Dataset Lab's core CSV lifecycle and boundaries passed the same live stack. Model Benchmarks now has one successful real browser/provider/Redis/worker/Mongo six-call run plus cancellation, export, completed-run restart persistence, scope separation, and archive-guard evidence. Successful Chat token streaming through the standard host listener, early access revocation/reset/MFA and broader remote matrices, the full Socket.IO matrix, Code Lab host isolation, hostile Dataset resource tests, and the remaining Project/Document/Dataset features still require their own complete integration/E2E execution. The test baseline does not yet satisfy the master platform test matrix.

Next live priorities: prove the missing real remote-host/provider acceptance cell, add early access-revocation and background session-sweeping coverage, extend performance proof to sustained/mixed/multi-user workloads, make host Ollama reachable to Docker for successful Chat streaming, and immutable-lock Notebook Mode on an AppArmor-capable host. The bounded same-host Hybrid protocol cell is Experimental and recorded above.

## Phase 2 runtime/provider slice

Completed and locally verified in this slice:

- Added authenticated, secret-safe runtime topology at `/api/v1/settings/runtime`.
- Added provider health, model listing, and connection testing under `/api/v1/settings/providers`.
- Rebuilt Settings around backend-reported deployment mode, provider state, models, service locality, missing dependencies, and restart-required fields.
- Removed fake Settings persistence/delete actions and hard-coded Settings model data.
- Added exact configuration-missing messages for Code Runner, Document Processor, OCR, and ChromaDB.
- Buffered Ollama NDJSON across arbitrary network chunks and made malformed/truncated streams fail explicitly.
- Removed the API-process document-job stub. Uploads now persist one fixed processor-unavailable terminal state, and runtime topology never claims that an unused endpoint setting makes the missing adapter operational.

The provider-neutral request/stream contract, default-model/resource controls, cancellation, Ollama, OpenAI Chat Completions, Anthropic Messages, OpenAI-compatible, and custom-compatible adapters are implemented and unit-tested. Still required before Phase 2 is complete: schema-bearing structured-output contracts, safe live switching/persistence, external-provider opt-in smoke tests, and the live local Ollama Compose E2E. No provider fallback is performed.

## Phase 3 Core AI slice

Completed and locally verified in this slice:

- Added an authenticated provider-neutral model catalog and metadata API.
- Added streamed Ollama model pulls and explicit unsupported responses for providers that cannot manage installations.
- Added one-use, 60-second model deletion confirmations scoped to the authenticated user, provider, and model; only token digests are retained.
- Added an argument-array `nvidia-smi` probe with a three-second timeout and explicit missing-driver/tool/GPU/malformed states.
- Added deterministic smart routing for chat, coding, reasoning, document, RAG, repository, extraction, and workflow tasks.
- Smart routing stays within the configured provider, honors an installed preference, applies a conservative VRAM budget when measurements exist, and returns selection reasons.
- Added the Models page, live provider model choices in Chat, task selection, smart-routing controls, and visible provider/model decisions.
- Replaced Chat's whole-document, success-only save with an atomic request-id lease: the user turn is durable before inference and the assistant terminal record captures success, safe provider failure, timeout, output limit, cancellation, or stale-process interruption.
- Added exact 4,000-character/16-KiB prompt validation, a 1-MiB recent-context cap, 256-KiB output cap, 64-message document boundary, bounded summary pagination, actual provider/model/usage/timing metadata, safe errors, named SSE events, explicit Stop, and startup/periodic stale-generation recovery.
- Hardened the browser stream state machine against malformed JSON, event reordering, identity changes, duplicate/missing terminal events, early EOF, stale navigation, and old-request state races. Voice Assistant and Workspace now consume the same strict contract.

Focused Chat verification passes 21 service/model tests, 10 route tests, and 16 frontend DTO/SSE parser tests. A disposable real-browser account verified the 4,001-character rejection, direct provider timeout, explicit Stop, fixed safe messages, actual provider/model/latency display, Mongo persistence, reload persistence, and zero console errors; its account and conversation were removed afterward. Successful output tokens remain unverified because host Ollama is still bound to `127.0.0.1:11434`, which the backend container cannot reach. Model list/pull/delete, GPU measurement, successful Chat routing/streaming, and fixed-suite model benchmarks still need their target-host provider/GPU paths. Benchmark history is not yet a Smart Router input.

## Phase 4 Project Rooms slice

Completed and locally verified in this slice:

- Added an owner-scoped Project model with active/archive state, tags, descriptions, compound indexes, and a bounded 100-event activity history.
- Added validated create, list, read, edit, archive, restore, and delete APIs. Missing and cross-owner resources use the same `404` response.
- Added short-lived, one-use project deletion confirmations bound to the user and project; only token digests are retained in memory.
- Added a Projects page with real lifecycle actions and visible activity.
- Added server-validated project context for chat conversations, documents, and agents. Archived projects are readable but reject new or mutating project work with `PROJECT_ARCHIVED`.
- Added project-filtered compound indexes for conversations, documents, and agents.
- Replaced the legacy mocked Agent edit with an owner-scoped validated API and replaced simulated Agent execution with the real authenticated SSE stream and cancellation.
- Added `PATCH` to the exact CORS method policy used by project and agent edits.
- Reconciled the selected Project Room from canonical reload results, and added accessible names to icon-only lifecycle controls.
- Serialized project-document deletion with project archive/restore mutations. Archived document deletion returns `PROJECT_ARCHIVED` before storage or Mongo mutation; retained orphan documents remain cleanable after a non-cascading project deletion.

Automated verification covers schema validation, ownership boundaries, archived behavior, deletion token expiry/reuse, project filtering, upload cleanup, agent updates, frontend context parsing, CORS policy, builds, and lint. A production-Compose real-browser path additionally passed create/edit/tag/activity, selected-room reconciliation, project-document upload/list, application restart persistence, archive read-only/delete rejection, restore/delete, guarded project deletion/reload, one-use confirmation replay rejection, and direct plus forged-scope rejection for a second authenticated user. Project Rooms remain **Experimental** because export/import, cascade/orphan policy across every associated resource, and the complete associated-feature matrix are not implemented or live-verified.

## Phase 5 Code Lab slice

Completed and locally source-verified in this slice:

- Added an authenticated, owner/project-scoped Code Run API and persistent run history for Python 3.12 and JavaScript 22.
- Added a real Code Lab UI with runtime availability, source/stdin, run/stop, bounded status polling, manual refresh, stdout/stderr, exit/duration and reported runner diagnostics. It never evaluates code in the browser or backend process.
- Added a dedicated BullMQ broker which creates disposable runtime containers through structured Docker CLI arguments. User programs receive no Docker socket, host mount, network, capabilities, or root user and have fixed CPU, RAM, PID, temporary-storage, output, and execution-time limits.
- Added cancellation, timeout/output/OOM states, safe cleanup, a credential-safe Redis heartbeat, missed-event replay, periodic stuck-run reconciliation, runner-result identity validation, and label-scoped stale-container cleanup.
- Added the disabled-by-default `code-lab` Compose profile. Startup validates the exact socket group and refuses to pull runtime images during a request.
- Removed fabricated Workspace AI output, fake document upload progress/context actions, unsupported social-login controls, and false demo credential guidance.

This earlier source-only assessment is superseded by the 2026-09-20 acceptance entry above: the supported Python/JavaScript critical path is **Complete**. Immutable runtime digest selection, additional languages, and public multi-tenant certification remain outside that scoped completion claim. Broker access to a Docker daemon is privileged infrastructure access; a dedicated or rootless daemon is recommended.

## Phase 6 Document Studio slice

Completed and locally source-verified in this slice:

- Replaced the broad File Actions mock with three real browser-local PDF utilities: ordered merge, selected-page extraction, and selected-page rotation.
- Added strict PDF filename/media/signature checks; 25 MiB per-file, 75 MiB aggregate, 10-file, 500-page, and 100 MiB output limits; encrypted/malformed handling; ordered page-expression parsing; and stable actionable error codes.
- Tests generate real PDFs, execute each operation, reload every output with `pdf-lib`, and verify page order/count/rotation, caller-byte immutability, selection rules, and limit/error branches.
- PDF inputs remain in the browser and results download locally. The UI states that outputs are not persisted to Documents or Projects, uses indeterminate processing rather than invented percentages, and revokes result object URLs.
- File metadata, type, count, and per-file/aggregate byte bounds are checked before any content read; inputs are read sequentially. Page expressions are length/token bounded, unexpected failures map to a fixed public error, and download names are normalized and stripped of path/control characters.
- The UI explicitly warns that structural transformations do not sanitize active PDF content and that generated files remain untrusted.
- Removed unsupported Office/image conversion tiles, search entries, and the disconnected Resume Actions route from shipped navigation.
- Disabled native LibreOffice/Poppler execution in the backend API. `/api/v1/documents/convert` now returns authenticated `503 DOCUMENT_PROCESSOR_UNAVAILABLE` without multipart/native parser middleware.
- Document list responses do not expose internal paths, filenames, extracted content, user IDs, or raw processor errors. PDF uploads use the opt-in isolated processor and owner-scoped detail endpoint; unsupported/unconfigured processing retains an explicit unavailable state. Failed DB creation cleans uploaded files; deletion is owner-scoped, blocks active processing, validates upload-root containment, and uses asynchronous cleanup.

The six-operation browser-local PDF utility surface plus the isolated PDF text-extraction and bounded OCR-ingestion slices are verified as described above. Overall Document Studio remains **Experimental**. Server conversion, searchable PDF output, PDF preview/thumbnails, compression, images, watermark/page numbers, batch jobs, OCR queues/progress/cancel, and Office conversion remain Planned. Untrusted native PDF/OCR processing remains outside the backend process.

## Phase 7 Knowledge / RAG slice

Completed and locally source-verified in this slice:

- Added a distinct `AI_EMBEDDING_MODEL`; the chat model is never substituted for missing embedding configuration.
- Added a bounded ChromaDB 0.4.24 client for heartbeat, collection, upsert, query, and owner-filtered deletion with strict response validation and fixed, non-leaking errors.
- Added owner/workspace/project-scoped metadata, synchronous UTF-8 TXT/Markdown ingestion, normalized overlapping chunks, batched embeddings, partial-vector cleanup, and explicit provider/model/dimension/chunking mismatch errors.
- Added retrieval with both Chroma owner/scope filters and post-retrieval validation against ready MongoDB source records. Raw Chroma distance is returned; no fabricated relevance score is produced.
- Treats retrieved content and source labels as untrusted prompt data, rejects control characters in labels, and returns source markers and bounded excerpts derived by the backend.
- Added a Project-aware Knowledge page with exact dependency failures, UTF-8 file validation, bounded refresh, archived read/query behavior, retrieved-source inspection, and no fabricated availability.

Status now skips provider discovery when the embedding model is absent or embeddings are unsupported; otherwise discovery shares a five-second deadline. On 2026-09-15 the live status endpoint reported reachable ChromaDB and explicit missing embedding configuration, without a provider probe. That request and a persisted Repository Analyzer report fetch completed together in 33 ms; this is not an ingestion/query benchmark.

Knowledge/RAG remains **Experimental**. The TXT/Markdown path and bounded stored PDF/OCR snapshot path have now executed against real MongoDB, ChromaDB, Ollama embeddings/generation, browser UI, deletion, and service restart persistence. DOCX ingestion, reranking, repository knowledge, background indexing/recovery, pagination/quotas, reindex controls, remote/Kubernetes proof, and conversational RAG memory remain Planned or unverified. See [docs/RAG.md](docs/RAG.md).

## Phase 8 Repository Analyzer slice

Completed and locally source-verified in this slice:

- Added authenticated, owner/project-scoped create, list, detail, status, and guarded deletion APIs for deterministic ZIP reports.
- Added a project-aware Repository Analyzer page with bounded ZIP prechecks, exact evidence views, explicit full-report loading, JSON export, archived-project read-only behavior, and stale-request protection.
- Added strict in-memory ZIP admission and parsing limits: 10 MiB upload, 2,000 entries, 25 MiB declared uncompressed data, 5 MiB per entry, 100:1 compression ratio, bounded paths/manifests/dependencies, two concurrent analyses, two uploads per minute, and a 15-second timeout.
- Rejects encrypted, multi-volume, nested-archive, traversal/absolute/backslash/control/ambiguous/colliding/symlink/device archives; reads only selected bounded `package.json` manifests and verifies their CRC32. It never extracts files, runs code or package scripts, installs dependencies, writes repository contents, or performs network access.
- Stores only bounded analysis metadata/evidence and package-script names, never uploaded ZIP bytes, complete file contents, script commands, credential-bearing dependency specifications, owner IDs, or internal database fields in public responses.
- Workspace and project histories are disjoint. A separate owner-scoped `?scope=orphaned` recovery view lists reports from deleted projects for reading, export, and deletion; mixed or invalid scopes fail closed.
- Fixed the multipart part-count boundary that rejected a ZIP plus name and project ID, wrapped-repository GitHub CI detection, and stale archived-project controls. Publishing/deleting reports shares the in-process project mutation lease and rechecks project state; ObjectId case is normalized so equivalent IDs cannot acquire separate leases.
- Added a 100-report per-user retention cap with authenticated deletion to recover capacity.
- Added strict deterministic 50-item pagination across workspace, exact-project, and deleted-project recovery histories, so all 100 retained reports remain reachable without deleting newer reports.

Production-Compose browser verification completed on 2026-09-15: workspace/project ZIP uploads returned 201, exports worked, archive refresh disabled mutations, workspace/project lists stayed disjoint, and a second user received 404 for a foreign report. A traversal ZIP returned 400. Reports survived restart; after deleting the disposable project, its recovery-view report could still be listed, opened, exported with an identical checksum, and deleted. Only disposable test users/projects/reports were cleaned up; report exports were retained as evidence.

Repository Analyzer remains **Experimental**. Pagination, bounded classic-ZIP end discovery, same-container child-process availability isolation, and dedicated non-root/network-disabled local/production Compose importer isolation are implemented and verified. Broader target-host adversarial CPU/native-memory/concurrency measurements, stronger cross-field response validation, and Kubernetes importer isolation remain pending. Project leases are not distributed. GitHub URL import, selected local directories, repository RAG, AI architecture analysis, and build/test execution remain Planned. See [docs/REPOSITORY_ANALYZER.md](docs/REPOSITORY_ANALYZER.md).

## Phase 9 Agent Runtime slice

Implemented in this source slice:

- Added a persistent, owner/agent/project-scoped `AgentRun` record with bounded prompt and output, provider/model/usage metadata, safe error states, timestamps, and a bounded lifecycle audit timeline.
- Added authenticated paginated run-list, detail, SSE execution, idempotent cancellation, and terminal-run deletion APIs. Startup and 30-second periodic reconciliation mark sufficiently stale active records `interrupted`; they do not resume them.
- Snapshotted the agent name, requested model, temperature, empty tool list, and system-prompt hash so later agent edits do not rewrite historical run metadata.
- Enforced safe UTF-8 prompt validation, output and history bounds, a runtime timeout, owner-scoped reads, archived-project read-only behavior, and guarded agent deletion so audit records are not orphaned.
- Added the browser history/detail/timeline view, 50-record pagination, confirmed terminal-run deletion, and a 500-retained-run owner cap.
- Kept the agent tool allowlist empty. Non-empty tool configuration is rejected and the provider request contains no tool definitions, so this slice performs no filesystem, command, network-tool, or third-party write actions.

The local single-replica Phase 9 runtime slice is **Implemented** after the production browser/provider/Mongo success, cancellation, deletion, and restart-persistence path passed. Overall Agents remain **Experimental**. The active-run registry, one-run-per-owner rule, execution lease, abort controllers, and count-then-create retention enforcement are held in one backend process; they do not coordinate multiple replicas, survive an in-flight restart, deliver cancellation across processes, or provide an atomic distributed quota. No approval layer is needed while tools remain disabled, but write-capable tools must not be added without server-enforced authorization, validation, audit, and consequence-appropriate approvals.

Run detail intentionally persists and returns the normalized prompt and generated output. Terminal-run deletion and a 500-run owner cap are present, but there is no age-based retention, bulk purge, redaction, or application-level encryption control, so prompts must not contain secrets. The target-host browser/configured-provider/MongoDB success, cancellation, terminal deletion, and completed-history restart paths passed on 2026-09-21; timeout remains regression-tested rather than live-accepted. See [docs/AGENTS.md](docs/AGENTS.md).

## Phase 10 Experimental Workflow slice

Implemented and production-browser verified as this deliberately fixed workflow:

```text
Input -> Prompt -> LLM -> Output
```

The Phase 10 contract is limited to:

- owner-scoped workflow definitions with server-validated optional project context;
- mutation and execution for active-project workflows, with archived-project definitions and run history read-only except that an already-active or orphaned run may be cancelled as a safe-shutdown action;
- provider-neutral SSE text generation whose output is always inert and is never executed;
- persistent bounded run summaries, owner-scoped detail, cancellation, lifecycle timelines, and explicit terminal-run deletion;
- 16 KiB input, prompt-template, and system-prompt limits, a 256 KiB output limit, the validated `AI_TIMEOUT_MS` provider deadline (30 seconds by default), a 100-definition and 500-run owner retention cap, pages of at most 50 summaries over at most ten pages, and at most 50 timeline events; and
- one process-local active workflow run per owner. Definition and run retention use non-atomic count-then-create checks that are not multi-replica quotas; Workflow and Agent leases are separate and do not form a shared GPU queue.

This is not a general workflow or automation engine. Tool, shell, code-runner, agent, RAG, Knowledge, document, PDF, OCR, repository, action, branching, loop, and arbitrary-node execution are outside this slice. Inputs, outputs, prompt templates, and system prompts are retained as application-readable plaintext, and each run snapshots the full definition including its template and system prompt; they must not contain secrets or regulated data.

Focused Phase 10 verification passes 33 backend tests and 18 frontend Workflow/model/transport/Nginx tests, both production builds, and the real local browser/Ollama/Mongo cancellation and restart-persistence path.

The local workspace-scoped single-replica fixed-text critical path is **Implemented**. Phase 10 overall remains **Experimental** until additional node types and the remaining project/archive, second-owner, live-bound, distributed, remote, and Kubernetes paths are implemented and exercised. See [docs/WORKFLOWS.md](docs/WORKFLOWS.md).

## Phase 11 Dataset Lab slice

Implemented in this source slice:

- Added authenticated, owner-scoped workspace/project CSV and flat-object JSON ingestion with server-validated immutable project association.
- Enforced 5 MiB source, separate 10 MiB derived-input/output, 10,000-row, 100-column, and 16 KiB UTF-8-cell limits, plus at most 50 preview rows and 500 characters per previewed string. The derived bound accounts for serialization and formula-escaping expansion.
- Added deterministic schema/type, missing-cell, duplicate-row, numeric, bounded category, IQR outlier, and bounded correlation analysis. Uploaded data is not sent to Python, a model, or another AI service.
- Persisted immutable originals in the backend uploads volume and owner/project metadata, analysis, bounded preview, checksums, and derivation relationships in MongoDB. API responses and private attachment downloads do not expose internal paths or generated filenames.
- Added explicit derived copies for string trimming, duplicate-row removal, missing-row removal, and CSV spreadsheet-formula escaping. Derivation never overwrites its parent; JSON scalar types are retained, and a parent with derived children cannot be deleted first.
- Enforced archived-project history behavior: datasets remain readable/downloadable, while upload, derivation, and deletion require an active project.
- Added a 100-record owner retention cap plus process-local upload admission and rate controls. The count-then-create quota is not atomic across concurrent requests or backend replicas.
- Fixed the Mongo workspace list filter so project records cannot leak into the workspace view, and made fresh backend project status override stale page context for mutation controls.
- Added proper accessible dialog semantics to the shared confirmation component used by Dataset deletion and other destructive flows.

Focused Phase 11 Dataset Lab verification passes 45 backend model/parser/service/route/project-mutation tests and 8 frontend contract tests.

Dataset Lab remains **Experimental**, but its core target-host path passed on 2026-09-05. Two real browser users exercised UI upload, deterministic analysis, exact original download, all four CSV transforms, independently hashed derived output, immutable parent/child lineage, parent deletion rejection, disjoint workspace/project lists, MongoDB/backend/frontend restart persistence, archived read/download with disabled UI mutations, direct `PROJECT_ARCHIVED` enforcement, second-user forged-scope plus direct record/download/derive/delete rejection, restore, dependency-ordered UI deletion, and project cleanup. Partial-write cleanup, disk-full behavior, exact live byte/row/column/cell/quota boundaries, hostile-input CPU/RAM behavior, JSON browser upload, charts, target selection, and ML task recommendations remain unverified or Planned. Original files, derived files, previews, and category values are application-readable to service, database, filesystem, and backup operators; deletion is not secure erasure and cannot remove prior backups. See [docs/DATASETS.md](docs/DATASETS.md).

## Phase 11 Model Benchmarks slice

Implemented in this source slice:

- Added authenticated workspace/project benchmark execution for immutable `chat-core-v1`: three fixed benign prompts, two sequential repetitions, six calls, and fixed generation parameters against the explicitly selected listed chat model.
- Added reconnectable provider-neutral SSE, explicit Mongo-first cancellation, bounded persistence, startup reconciliation, archived/deleted-project handling, and strict owner-scoped history/detail/deletion APIs. Disconnecting a browser does not cancel a durable run.
- Recorded measured per-call wall time, TTFT when observable, output bytes, provider-reported usage only, aggregate medians, total wall time, actual provider/model identity, and sanitized before/after GPU snapshots without UUIDs.
- Added a browser page with scope/archive awareness, model selection, six-call progress, stop/reconnect behavior, paged history, detail, compatible comparison, confirmed deletion, dependency-specific errors, and JSON export.
- Added a dedicated portless BullMQ worker with opaque-id jobs, attempts-one delivery, checkpointed calls, retained-job recovery, worker heartbeat, graceful shutdown, and a fenced renewable Redis global lease. Mongo revision/fence/owner compare-and-swap prevents stale mutations, and a partial unique Mongo index enforces one active run per owner.
- Enforced 16 KiB per call, 128 KiB per run, 180-second timeout, 100 retained runs per owner, 25 records per page over at most ten pages, and a 50-event timeline. Uncertain in-flight provider calls are interrupted rather than retried.

Focused Model Benchmarks verification passes 40 backend model/queue/lease/executor/worker/service/route tests and 6 frontend strict-contract tests. Provider-discovery deadlines add three separately focused backend tests. See the current repository-wide verification table above. The frontend build retains the pre-existing large-chunk warning; the 2026-09-15 serial backend run passed without the earlier worker teardown warning.

Model Benchmarks remains **Experimental**. On 2026-09-07 a real production-Compose browser run used listed `phi3:latest` through a temporary internal CPU-only Ollama service and completed 6/6 calls in 85.26 seconds. Redis dispatch, the dedicated worker, Mongo checkpoints/history, provider/model identity, six ordered results, TTFT/duration/output/token aggregates, a 16-event timeline, JSON export (SHA-256 `5cb45e272ac236dfbd7fe303201580477b21a3de088362bd6a164f1c9a0bf6bb`), and completed-run backend/worker restart persistence passed. A running workspace run cancelled at 0/6, a project run cancelled at 2/6, workspace and project histories stayed disjoint, and fresh archived-project status kept history readable while disabling creation/deletion. The default worker correctly reported GPU unavailable because it had no GPU grant. Standard host-Ollama reachability, two-success comparison, active queued/checkpoint/in-flight restart recovery, timeout/output-limit live paths, remote billing/cancellation, target-host GPU samples, cross-user isolation, retention limits, and multi-replica races remain unverified. Passing means operational completion, not answer correctness or model quality. Raw outputs and metadata remain application-readable and may persist in backups. See [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Phase 11 Notebook Mode

The authenticated owner/project editor now connects to a durable run path. The browser exposes Run/Stop, dependency-specific availability, progress polling, verified inline output, bounded run history/detail, and confirmed terminal-run deletion. MongoDB owns immutable snapshots and lifecycle state; BullMQ carries opaque attempts-one jobs; a partial unique index allows one active notebook run per owner.

The opt-in portless broker alone receives Docker-daemon access. It creates a bounded network-disabled UID-10001 runtime, streams strict hash-checked input/output envelopes without host mounts, force-removes the runtime, and only then creates a distinct UID-10002 verifier that executes no notebook code and independently reconstructs canonical inert output, metrics, and artifacts. The worker has an expiring Redis lease/heartbeat, canonical cancellation polling, stale-transition compare-and-swap, label-scoped recovery, and a real two-stage startup canary. Lease/heartbeat loss interrupts rather than completes the current run.

Verification on 2026-09-02 passed all 68 runtime tests inside the image, 65/68 on the host with three image-only skips, focused worker lease-loss and missed-notification tests, and the then-current repository gate. The separately executed repository test components on 2026-09-15 total 617 passes plus the same three skips. A disposable authenticated API test through frontend port 3002 passed execution with exact stdout, distinct runtime/verifier image IDs, immutable snapshot identity, running-job cancellation, two-record history, backend-restart persistence, and cleanup. A separate Playwright browser test passed registration from `127.0.0.1:3002`, navigation, blank-notebook creation, edit/save to revision 2, isolated execution with `browser-notebook-result 42`, reload persistence, run deletion, notebook deletion, sign-out, and scoped account cleanup. MongoDB, Redis, ChromaDB, backend, frontend, and both workers were healthy afterward with no disposable notebook container left behind.

Notebook Mode remains **Experimental**, not production-certified. The CachyOS daemon reports seccomp but no AppArmor, so the live functional test explicitly used `NOTEBOOK_REQUIRE_APPARMOR=false`; the repository default remains fail-closed with AppArmor required. Runtime transitive dependencies/local tags are not digest-locked, artifact downloads and age-based retention are absent, only one worker is supported, and remote/Kubernetes/multi-tenant hardening is unverified. ML experiments, model training, Python/AI dataset transformations, and a general shared GPU queue remain Planned. See [docs/NOTEBOOKS.md](docs/NOTEBOOKS.md).
