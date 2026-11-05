# Production Compose foundation verification

Date: 2026-10-22  
State: Experimental

## Work board

| Owner | Scope | Acceptance | Evidence | Merge gate |
| --- | --- | --- | --- | --- |
| Primary | Standalone production topology and fail-closed configuration | Private data plane, loopback-only edge, immutable images, safe lifecycle | Contract tests, rendered Compose, container inspection | Focused tests, syntax, build, diff check |
| Primary | Isolated live remote-provider path | Browser/API/provider streaming plus restart and recreation persistence | Browser result, provider marker, same user id | Exact fixture cleanup and test-volume removal |
| Security reviewer | Read-only boundary review | No public datastore/internal service, bounded secret and lifecycle behavior | Independent findings incorporated or recorded | No unresolved critical finding |
| Test reviewer | Read-only verifier review | Coverage and cleanup accurately support bounded claims | Independent findings incorporated or recorded | No unsupported completion claim |
| Documentation reviewer | Read-only state review | Experimental wording and remaining blockers are explicit | README/status/roadmap/docs review | No Complete/remote-host/TLS claim |

## TDD and static contracts

The initial focused test failed because `scripts/production-environment.cjs` did not exist. Subsequent red states exposed an unsafe test credential containing the placeholder sentinel, an invalid Compose PID-limit combination, and a missing live verifier. After implementation, `npm run test:production` passed the configuration, topology/persistence/resource, and lifecycle/verifier contracts.

The preflight parser treats the environment file as data, rejects symlinks, duplicate/unknown names, Compose interpolation, quoting/escaping ambiguity, whitespace, and controls. It requires remote/hybrid mode, a loopback bind and unprivileged port, HTTPS public/provider URLs, matching HTTPS CORS origin, an authenticated supported provider, distinct non-placeholder JWT secrets, distinct root/application Mongo credentials, URL-safe datastore credentials, and non-sentinel digest-pinned images. The checked-in example intentionally fails until every placeholder is replaced. These checks are enforced by the launcher; direct Compose invocation can bypass them.

The independent security review found that the first draft passed Mongo root credentials to the API/worker, did not validate the configurable edge bind, and let the custom parser disagree with Compose interpolation. The merge-gated revision adds a fresh-volume Mongo initializer for a database-scoped `readWrite` application user, requires `127.0.0.1`, constrains the port and identifiers, rejects ambiguous env syntax, separates fixture/provider tokens, and bounds Docker local logs. Secret-manager integration, Redis secret argv removal, datastore-per-network segmentation, destination-restricted egress, datastore read-only/capability hardening, and backup-gated upgrades remain future hardening.

The first live initializer attempt failed and restarted once because the draft used unavailable `mongosh` helper `_getEnv`; application authentication correctly failed. After replacing it with `process.env`, a brand-new isolated volume initialized with zero restarts. The application user successfully inserted and removed a marker in `kfive_ai`, while an admin `usersInfo` operation failed with authorization code 13. The marker collection was left empty and the exact disposable container/network/volume were removed.

## Compatible dependency security refresh

On 2026-10-24, `npm audit fix --omit=dev` first updated compatible transitive/runtime resolutions in the lockfile. A later bounded security slice then upgraded exact direct Axios 1.18.0 → 1.20.0 and Multer 2.2.0 → 2.5.0 dependencies. The final `npm audit --omit=dev` result is 8 moderate, 0 high, and 0 critical findings across 427 production dependencies. Remaining paths are Tailwind/PostCSS, React Router, and BullMQ/UUID; advertised remedies require separately reviewed dependency-range or major changes. Complete backend/frontend tests and builds passed after the upgrades. This is remediation evidence, not a clean-security, exploitability, or reachability claim; see [the later auth/security evidence](production-auth-live.md).

An independent final review then found that `.env.production.example` was unintentionally ignored, private `.env.*` files were not comprehensively excluded from Docker build contexts, and the documented external TLS proxy added a second hop while the backend trusted only one and frontend Nginx replaced the HTTPS scheme. Red tests reproduced all three contract gaps. The corrected configuration explicitly re-includes only the safe production example, excludes private environment variants from build contexts, preserves the sanitized outer forwarding chain for API and Socket.IO, bounds backend proxy trust to 0–2 hops, requires exactly two in production preflight, and uses one only in the direct-HTTP acceptance harness. The focused production, environment/application, and Nginx proxy regressions passed after the fix.

## Live topology and remote-provider protocol

The disposable project used five explicit `kfive-production-test-manual_*` volumes and four isolated networks. This acceptance overlay intentionally used local mutable images and internal HTTP origins, so it did not pass through the production HTTPS/digest launcher preflight. Container inspection showed:

- frontend alone on `edge`, publishing exactly `127.0.0.1:18088 -> 8080`, and also on internal `app_internal`;
- backend on internal `app_internal` and `data_internal`, plus `provider_egress`, with no published port;
- MongoDB, Redis, and ChromaDB only on internal `data_internal`, with no published ports; and
- the authenticated fixture only on `provider_egress`, with no published port and no host Ollama dependency.

The first live attempt found a real defect: frontend was attached only to an internal network. Docker retained the port-binding configuration but did not publish it. A regression now requires a distinct non-internal edge network with only frontend attached.

A real Chromium session loaded `KFive AI - AI Workspace`, received 200 from health/readiness, registered a disposable account, listed provider `openai-compatible` and model `remote-chat`, created a conversation, and streamed a completed event containing exactly `REMOTE_PROVIDER_VERIFIED`. The stream reported provider/model identity and no error event.

After the security revision, a second fresh-volume current-manifest Chromium pass repeated registration, model discovery, conversation creation, and streaming chat through the database-scoped application user. It returned HTTP 200, the same verification marker/provider, a completed event, and no error event. Direct fixture requests with no bearer token and with a wrong token both returned 401. Exact cleanup removed conversation `6ada1de6a0842a0570dc1252` and user `6ada1de6a0842a0570dc124f`, confirmed zero matching records, then removed only the five `kfive-production-test-final_*` volumes.

Restarting MongoDB and backend preserved login. Next, `docker compose down` removed every acceptance container and network without volumes. Recreating the project over the same five named volumes returned HTTP 200 for login and the identical Mongo user id `6ada0fae0bddd196e596542e`, proving Mongo identity persistence across full container/network recreation. All five volume objects retained their identities, but Redis data, Chroma records, uploaded-file bytes, and log contents were not separately written and read; no broader data-persistence claim is made.

## Cleanup and user-data safety

Before teardown, an isolated Mongo client deleted only conversation `6ada0fb90bddd196e5965438` and user `6ada0fae0bddd196e596542e`; both remaining counts were zero. `down -v` then removed only the five explicitly named `kfive-production-test-manual_*` volumes and their networks. The second current-manifest pass was cleaned with the same exact-target procedure. The existing six `kfive-ai_*` volumes remained present. The original Compose core and optional containers were restarted without recreating or deleting those volumes; the Notebook worker subsequently exited because its daemon-isolation canary could not pass on the same AppArmor-broken host, while the remaining processes stayed up.

## Host healthcheck limitation

The Docker daemon returned the following OCI failure for every exec-based healthcheck, including unchanged MongoDB/Redis/ChromaDB and the tiny fixture:

```text
apparmor failed to apply profile: operation not permitted
```

This is a host daemon/AppArmor condition rather than an application assertion: containers and real frontend/API/auth/provider traffic ran, but Compose `--wait` could not report healthy. The same condition affects the restored development stack. Therefore health-gated startup on a clean target daemon remains unverified and must not be inferred from the successful HTTP path.

## Claim boundary

Proven: bounded local production-Compose topology, private service publication, authenticated remote-provider **protocol**, real browser/API streaming, Mongo/backend restart persistence, Mongo identity persistence plus preservation of all named volume objects across container recreation, and scoped cleanup. Unit-level preflight validation and both base/overlay Compose rendering passed; the real production launcher, registry pull, and HTTPS edge were not executed.

Not proven in this historical run: immutable registry pulls, real provider SaaS, remote host, public DNS, TLS, external reverse proxy, remote storage, backup/restore, failover, multi-host operation, operational alerting, migration, performance, horizontal scaling, or operation while the development laptop is offline. A later separate slice proves bounded same-host/same-image application recovery; see [backup/restore evidence](production-backup-restore-live.md). Remote DR remains unproven. The slice remains Experimental.
