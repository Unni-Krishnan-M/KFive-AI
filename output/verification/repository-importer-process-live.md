# Repository Analyzer child-process isolation verification

Date: 2026-11-06  
State: **Implemented process/event-loop/crash isolation; overall Repository Analyzer remains Experimental**

## Accepted slice

Repository ZIP analysis now executes in a one-shot Node child process selected by a fixed executable and worker path. The parent sends one versioned binary frame containing bounded metadata and at most 10 MiB of archive bytes. The child receives only `NODE_ENV=production`, runs with a 96 MiB V8 old-space limit plus an 8 MiB semi-space limit, emits one bounded versioned response, and is killed at the parent deadline or when output exceeds 4 MiB. The parent reconstructs only allowlisted archive errors and verifies the returned source metadata and SHA-256 against the original request before persistence.

This is availability isolation for the backend event loop and parent process. It is **not** a security sandbox: the normal Compose child still shares the backend container's UID, filesystem, process/network namespaces, and cgroup. V8 heap flags do not cap all native/Buffer memory. A dedicated network-disabled importer container with independent OS resource controls remains required.

## TDD and focused contracts

The initial focused isolation test failed because the worker module did not exist. After implementation, an independent review found that a throwing `onSpawn` observer could reject before cleanup was armed. A new regression first failed with the raw observer error and a live child, then passed after listeners/deadline cleanup were installed before invoking the observer and callback failure became a fixed isolation error plus `SIGKILL`.

Final focused command:

```text
cd backend
npm test -- --runInBand src/services/repositoryArchiveIsolation.test.ts src/services/repositoryAnalysisService.test.ts src/services/repositoryArchiveAnalyzer.test.ts
```

Result: 3 suites, 57 tests passed. Coverage includes real child success, typed encrypted-archive rejection, minimal environment, crash, malformed/untrusted/oversized output, missing executable, hard timeout, observer failure cleanup, exact request framing, production default wiring, and archive regressions.

## Compiled-process acceptance

Command: `npm run verify:repository-importer-process`

Final built-code result:

```json
{
  "parentPid": 48428,
  "childCount": 3,
  "distinctChildPids": 3,
  "heartbeatTicks": 52,
  "reportsMatchDirectAnalyzer": true,
  "encryptedErrorPreserved": true,
  "remainingChildren": 0
}
```

Two valid archives ran concurrently in distinct children while a parent heartbeat advanced. A third child returned the canonical encrypted-entry error. Isolated and direct reports matched, and no child remained.

## Real Compose API and persistence acceptance

The final `kfive-ai-backend:latest` image was rebuilt and only the backend container was recreated. The existing MongoDB, Redis, ChromaDB, uploads, logs, and Ollama bridge volumes were reused. Notebook execution remained disabled.

Command: `npm run verify:repository-importer-api`

The verifier traversed the real loopback frontend proxy, authentication, multipart repository route, production service default, isolated child, and MongoDB:

```json
{
  "validArchivePersistedAndRetrieved": true,
  "reportSha256": "288af72fddcc9214bc84067e34a61174ffed5d93150e6c32fe94905dfc1ae0d8",
  "encryptedArchiveRejected": true,
  "encryptedAttemptPersistedReports": 0,
  "remainingImporterChildren": 0,
  "readinessBefore": "ready",
  "readinessAfter": "ready",
  "protectedVolumesUnchanged": true
}
```

The valid report was retrieved with its expected source checksum and tree. The encrypted upload returned HTTP 400 / `REPOSITORY_ARCHIVE_ENCRYPTED` and did not add a report. API deletion left zero reports. A guarded, read-only-root, capability-dropped disposable MongoDB client removed exactly the nonce-scoped user and confirmed zero user/report residue. Identity comparison passed for:

- `kfive-ai_mongodb_data`
- `kfive-ai_redis_data`
- `kfive-ai_chromadb_data`
- `kfive-ai_backend_uploads`
- `kfive-ai_backend_logs`
- `kfive-ai_ollama_bridge_socket`

The host Docker daemon cannot execute container healthcheck processes because AppArmor profile application returns `operation not permitted`. This is the previously recorded host limitation; real HTTP readiness and the authenticated API path passed. Service processes were not weakened to make Docker health status green.

## Hardened disposable-image proof

The exact final backend image also ran two parser children in a disposable container with `--network none`, a read-only root, a noexec/nosuid/nodev tmpfs, all capabilities dropped, no-new-privileges, 32 PIDs, 256 MiB, one CPU, no mounts, and automatic removal:

```json
{"uid":1000,"network":"none","readOnly":true,"childCount":2,"childDistinct":true,"fileCount":0}
```

This proves the image can execute the child under those explicit controls. It does not claim that the normal Compose backend currently gives its child those controls.

## Merge gates

- Full backend: 82 suites / 565 tests passed serially.
- Frontend: 23 files / 162 tests passed.
- Root production build: frontend, backend, and Code Runner passed.
- Root lint: frontend, backend, and Code Runner passed.
- Production contract tests: 6 passed.
- `docker compose config --quiet`: passed.
- `npm audit --omit=dev --audit-level=high`: 0 critical/high, 6 moderate.
- `git diff --check`: passed before documentation and repeated after final documentation.
- Independent implementation, security, and evidence audits accepted the bounded process-isolation claim after the observer lifecycle fix and required the security-sandbox limitation above.

## Remaining work

- Move parsing into a dedicated non-root, network-disabled importer service/container with its own filesystem and cgroup boundaries.
- Add comprehensive target-host CPU, native-memory, concurrency, crash, and recovery measurements.
- Strengthen cross-field semantic consistency validation for child reports; current validation enforces exact bounded shapes and request provenance but is not an independent re-analysis of every aggregate.
- Keep the overall Repository Analyzer Experimental until those boundaries and the broader repository-intelligence roadmap pass.
