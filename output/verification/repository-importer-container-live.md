# Repository importer container live verification

Date: 2026-11-13  
State: Implemented local/production Compose slice; overall Repository Analyzer remains Experimental

## Work board and merge gate

| Owner | Scope | Acceptance criteria | Evidence | Merge gate |
| --- | --- | --- | --- | --- |
| Root agent | Socket protocol, service selection/errors, daemon lifecycle, dependency repair | Explicit socket mode with no fallback; bounded child; safe unavailable/busy errors; no failed persistence; exact post-bind cleanup | Focused backend contracts and built runtime | Focused/full tests, build, lint, audit |
| Compose implementation agent | `backend/Dockerfile`, local/production Compose, production contract | Non-root/networkless importer; socket-only volume; backend read-only mount; resource/security bounds; ephemeral backup exclusion | Rendered models, image build, static contracts | Compose render and production contracts |
| Verifier implementation agent | Static and opt-in live verifier | Inspect runtime boundary and prove stop/failure/recovery/persistence/cleanup without deleting volumes | `scripts/repository-importer-compose.test.cjs`, `scripts/verify-repository-importer-container-live.cjs` | Static test plus real loopback execution |
| Implementation review agent | Read-only cross-file review | No fallback, correct error/persistence ordering, child only in importer | Independent GO before live run | No blocking findings |
| Security review agent | Read-only boundary/dependency review | No high/critical production audit finding; safe UDS lifecycle; no network/secrets/data/Docker socket | Review found Mongoose and post-bind blockers; both repaired under focused gates | Final re-review: GO |
| Evidence review agent | Read-only claims/evidence audit | Every Implemented claim maps to a runtime/static assertion; Experimental gaps remain explicit | Live verifier, docs, status, roadmap and final gates inspected | Final review: GO after wording corrections |
| Root acceptance | Real Compose frontend/API/importer/Mongo path | Valid/encrypted; SIGKILL/stale recovery; 503/no persistence; offline read; child ownership; restart persistence; exact cleanup; unchanged volumes | Live verifier JSON below | Every assertion passes |

## Implemented boundary

- Local and production Compose select `REPOSITORY_IMPORTER_MODE=socket` and the fixed `/run/kfive-repository-importer/importer.sock` path. Socket mode has no process fallback.
- The importer runs as UID/GID `10001:10002`; its socket directory is `0770` and its socket is `0660`. The backend keeps its normal identity, receives group `10002`, and mounts only the socket volume read-only.
- The importer has `network_mode: none`, no routable address, TCP listener, published port, secret, application/data mount, provider URL, or Docker socket. Its root is read-only; `/tmp` is a 32 MiB no-exec tmpfs; all capabilities are dropped; no-new-privileges and zero core dumps apply; limits are 1 CPU, 512 MiB, and 48 PIDs.
- Each request launches the already-reviewed one-shot parser child with its own V8/deadline/output limits. At most two are active. Client disconnect, timeout, or daemon shutdown kills the corresponding child.
- Startup validates the fixed parent/socket type, UID, GID, mode, inode, and active state. It unlinks only a revalidated stale socket. Post-bind hardening failure closes the listener, destroys accepted connections, and removes only the exact created inode.
- The production socket volume is explicitly labeled ephemeral and is absent from backup/restore sets.

## TDD and review repairs

The post-bind cleanup contract was first added against the unimplemented `setSocketMode` seam and failed TypeScript compilation because the option did not exist. The implementation then closed the listener, exact-inode checked/unlinked the created socket, and the focused suite passed 8/8 including immediate restart after injected hardening failure.

The security audit reproduced a high-severity Mongoose finding at locked 8.24.6. The dependency was narrowly upgraded to 8.24.7. Existing safe lock resolutions for `follow-redirects` 1.16.2 and Joi 17.13.9 were preserved. Six moderate findings require breaking upgrades and remain tracked; they are not represented as resolved.

## Real Compose execution

The verifier used only loopback `http://127.0.0.1:3002/api/v1`. It recorded the identities of these protected volumes before mutation and compared them afterward:

- `kfive-ai_mongodb_data`
- `kfive-ai_redis_data`
- `kfive-ai_chromadb_data`
- `kfive-ai_backend_uploads`
- `kfive-ai_backend_logs`
- `kfive-ai_ollama_bridge_socket`

It then proved:

1. Runtime importer/backend identity, mount, network, environment, capability, root-filesystem, tmpfs, CPU, memory, PID, restart, core-dump, socket, and no-TCP-listener constraints.
2. A valid ZIP persisted through the frontend proxy and returned its checksum-matched report.
3. The importer restart policy was temporarily disabled and the container was SIGKILLed, leaving the Unix socket path for stale-socket recovery.
4. Status reported `repository-importer` unavailable with `canAnalyze: false`; a new upload returned fixed `503 REPOSITORY_ANALYZER_UNAVAILABLE` and did not create a report. The previously saved report remained readable.
5. Restart recovered the exact stale socket and restored available status.
6. An encrypted ZIP returned the canonical 400 error and did not persist.
7. A valid 2,000-entry boundary archive exposed a transient `repositoryArchiveWorkerMain.js` child under the importer and never under the backend; no child remained afterward.
8. Joint backend/importer restart retained both saved reports.
9. Backend/importer logs contained none of the nonce, archive filenames, or content sentinels.
10. Both reports were deleted through the API; guarded Mongo cleanup matched exactly two nonce-scoped users and left zero reports/users.
11. All six protected volume identities and the ephemeral socket-volume identity were unchanged. The successful path explicitly restored the importer restart policy and running state; `finally` provides best-effort restoration if an earlier assertion fails.

The successful result was:

```json
{
  "validPersisted": true,
  "encryptedRejectedWithoutPersistence": true,
  "unavailableStatusAndFixed503": true,
  "existingReportReadableWhileImporterStopped": true,
  "staleSocketRestartRecovery": true,
  "parserChildObservedOnlyInImporter": true,
  "backendAndImporterRestartPersistence": true,
  "protectedVolumesUnchanged": true,
  "socketVolumeIdentityUnchanged": true,
  "logsExcludedArchiveMetadataAndContent": true,
  "cleanup": { "matchedUsers": 2, "reportsAfter": 0, "usersAfter": 0 }
}
```

This host blocks Compose exec healthchecks through AppArmor, so Docker reports several healthy real services as `unhealthy`. Real loopback readiness, authenticated API status, and the direct Unix-socket handshake were authoritative for this acceptance run.

## Final focused gates

- Focused post-bind/configuration regressions: 2 suites, 14 tests passed.
- Full backend: 83 suites, 576 tests passed. The first full run exposed a missing `EnvironmentConfig` fixture field and 31-worker ts-jest oversubscription of real child tests; the fixture was fixed and backend Jest was bounded to 25% of host CPUs before the clean run.
- Frontend: 23 files, 162 tests passed.
- Repository importer Compose contract: passed.
- Production contracts: 6/6 passed.
- Full frontend/backend/code-runner build and lint: passed.
- Local and production Compose rendering: passed.
- Production lockfile audit: zero high/critical; six moderate findings requiring breaking upgrades remain.
- `git diff --check`: passed.

## Classification and remaining work

The dedicated importer boundary is **Implemented for local and production Compose**. The overall Repository Analyzer stays **Experimental**. This run does not prove Kubernetes importer isolation, exhaustive native-memory/CPU behavior under hostile expansion and concurrent admission, full semantic reconciliation of every report aggregate, distributed project leases/retention quotas, or any planned GitHub/local-directory/RAG/AI/build adapter.
