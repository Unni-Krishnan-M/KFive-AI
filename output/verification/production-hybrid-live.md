# Production Compose hybrid acceptance

Date: 2026-10-25  
State: Experimental  
Final live nonce: `fe1b34161855`

## Work board and merge gate

| Owner | Scope | Acceptance | Evidence | Merge gate |
| --- | --- | --- | --- | --- |
| Primary | Hybrid runtime/provider path | Exact runtime classification and structural remote chat | Authenticated API and SSE | Success, outage, fail-closed result, recovery |
| Primary | Persistence/topology/cleanup | Restart persistence, private services, unchanged volumes, exact cleanup | Docker inspection plus API/Mongo checks | No nonce resources; all prior volumes unchanged |
| Matrix auditor | Contract completeness | Independent fixture, no fallback, bounded claim | Read-only review | No missing critical acceptance edge |
| Implementation reviewer | False-positive resistance | Structural SSE and durable state match claims | Read-only review | GO required |
| Security reviewer | Secrets/exposure/destruction | Private topology and ownership-gated cleanup | Read-only review | No unresolved critical/high finding |

## TDD and red-path corrections

`scripts/production-hybrid.test.cjs` first failed because the dedicated verifier and package commands did not exist. The completed contract requires explicit opt-in, literal hybrid mode, a separately managed provider container on provider egress, runtime inspection, structural SSE helpers, provider stop/start, fail-closed error evidence, restart persistence, ownership-gated cleanup, and no destructive broad volume/prune command.

Live development then exposed four verifier assumptions before the final pass:

- `fc01676afc18`: `/health` is a frontend SPA path; the supported proxied liveness path is `/api/v1/health`.
- `c7e44980cb78`: starting only data services did not create the unused provider network; application containers are now created without starting before the fixture is attached.
- `ece9a23cd682`: a zero-output failed generation omits `content`; the verifier now accepts only missing/empty content and requires `outputBytes: 0`.
- `204fdb636f9e`: all functional checks passed, but the host's known AppArmor fault blocked `docker exec` for Mongo cleanup. Cleanup now uses a read-only, capability-dropped, private-network `mongosh` helper.
- Independent security review found that raw child-process diagnostics could echo disposable credentials from command arguments. A red/green unit contract now proves exact registered values, provider-token assignments, password arguments, and private env-file paths are redacted before diagnostics are emitted. Earlier exposed values belonged only to destroyed disposable stacks and are no longer valid.

Every failed run entered ownership-checked cleanup. The final nonce was fresh.

## Final live result

The verifier built nonce-labelled current-source backend and provider images. The production application stack used `KFIVE_MODE=hybrid`, local MongoDB/Redis/ChromaDB and local upload/log volumes. An independently named provider fixture—not a Compose service or project member—joined only `provider_egress` under a non-local DNS alias. It was read-only, capability-dropped, `no-new-privileges`, and bounded to 64 MiB, 0.25 CPU, and 32 PIDs with no published port.

Only the frontend published `127.0.0.1:<random-port> -> 8080`. The exact network memberships were:

- edge: frontend;
- app-internal: frontend and backend;
- data-internal: backend, benchmark worker, MongoDB, Redis, and ChromaDB;
- provider-egress: backend, benchmark worker, and the independent provider fixture.

Public API liveness returned `healthy` and mode `hybrid`; unauthenticated runtime access returned 401. The authenticated runtime response reported API `v1`, mode `hybrid`, local configured MongoDB/Redis/ChromaDB, disabled Code Runner/Document Processor/OCR, and an `openai-compatible` HTTP provider classified `remote`. It contained no provider address, datastore address, generated credential, or environment-file path.

Provider model discovery returned `remote-chat`. The initial chat stream was structurally parsed: all named events used one request id; it contained one running generation, one `openai-compatible`/`remote-chat` start, exact delta text `REMOTE_PROVIDER_VERIFIED`, one succeeded terminal generation, `[DONE]`, and no error event.

The verifier stopped the exact labelled fixture and confirmed it was not running. Model discovery then returned 503 with `PROVIDER_UNAVAILABLE`, provider `openai-compatible`, and `retryable: true`, without credential disclosure. A chat attempt produced no start or delta, no alternate-provider event, and one durable failed terminal generation with `CHAT_PROVIDER_UNAVAILABLE`, zero output bytes, and the fixed safe message. Conversation retrieval preserved that failure and named no Ollama fallback.

Restarting the same fixture container restored discovery and an exact successful stream. Restarting MongoDB and the backend preserved all five volume identities; login returned the same user, the conversation retained both remote success and provider failure, runtime remained hybrid, and a new post-restart conversation completed through the remote protocol fixture.

A hardened private `mongosh` helper removed exactly two conversations and the test user and confirmed zero remaining records. Final cleanup removed only the exact labelled provider container/images, Compose-labelled project resources, and individually ownership-checked disposable volumes. Every volume that existed before the drill retained the same identity, and no final nonce resource remained.

## Verification commands

- `node --test scripts/production-hybrid.test.cjs` — passed.
- `npm run production:verify:hybrid` — passed with nonce `fe1b34161855` after the diagnostic-redaction and strict-SSE changes.
- `npm run test:production` — passed, 5/5 production contract files.
- `npm run build:backend` and verifier syntax validation — passed.
- `git diff --check` — passed after documentation.

Independent implementation review returned GO for the bounded Experimental claim. Independent security review found and gated the diagnostic-redaction fix, then returned GO; the post-fix live rerun above passed. Final documentation review found and corrected stale Hybrid-planning language and returned no code/evidence blocker.

## Claim boundary

This proves the Hybrid configuration's critical provider protocol and dependency behavior on one Docker host. The provider was independently managed but still ran on the same daemon and bridge; this is not a remote-host or hostile-tenant boundary. Local mutable images and internal HTTP were used.

It does not prove a real provider tenant, billing, provider data governance, WAN latency/failure modes, immutable registry pulls, public DNS/TLS, a remote host, multiple replicas, cross-host persistence/migration, off-host disaster recovery, provider failover, or operation after the development laptop is offline. Hybrid remains **Experimental**.
