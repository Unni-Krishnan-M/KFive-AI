# Production Compose backup/restore verification

Date: 2026-10-24 (Asia/Kolkata)  
State: **Experimental**

## Work board

| Owner | Scope | Acceptance | Evidence | Merge gate |
| --- | --- | --- | --- | --- |
| Root | CLI, contracts, live drill, docs | Offline coherent recovery into fresh resources | Tests and live output below | Green tests, semantic recovery, review, clean diff |
| Topology audit | Canonical state boundary | Mongo + Redis + Chroma + uploads; logs separate | Read-only repository audit | No missing canonical store |
| Security review | Collision, path, secret, privilege safety | No existing-resource overwrite; hostile input bounded | Independent review and fixes | No open release blocker |
| Evidence review | False positives and cleanup | Source destroyed; all components checked after restart | Independent verifier review | Exact cleanup and narrow claims |

## Contract and review fixes

`production:backup` requires explicit maintenance authority, a mode-0600 environment, exact running project/image/mount matches, label-owned volumes, and a 7-GiB source ceiling per component. It stops frontend, API, and benchmark worker; refuses active BullMQ lists; streams a logical gzip Mongo dump; forces Redis persistence; stops Redis/Chroma; and streams Redis, Chroma, and uploads archives. A versioned mode-0600 manifest binds each bounded artifact by size and SHA-256. Every stopped container is independently restarted in `finally`.

`production:restore` requires explicit fresh-volume authority. It refuses the source project/prefix, existing destination containers/networks/volumes, image/database mismatch, corruption, unsafe/duplicate archive names, links/special entries, excessive artifacts, member counts, and expanded size. It stages from already-open no-follow descriptors into a private directory, then uses only staged bytes. Each new volume receives a random restore token and is inspected before writing; failure cleanup removes only exact token-owned resources. Mongo input and backup output stream rather than buffering volume-sized data.

Independent review initially found a critical same-project collision, an idempotent volume-creation race, mutable-path validation gap, unbounded/in-memory artifacts, source mount ambiguity, partial cleanup, incomplete service restart recovery, and incomplete post-restart evidence. All release blockers were corrected before the final run. The remaining boundary is explicit: SHA-256 is corruption detection, not authenticity against a host/bundle administrator.

## TDD and static gates

The initial focused test failed because `production-backup-lib.cjs` did not exist. After implementation:

```text
npm run test:production
✔ scripts/production-backup.test.cjs
✔ scripts/production-compose.test.cjs
tests 2, pass 2, fail 0
```

Node syntax checks passed for the library, backup, restore, and live verifier. Tests cover the fixed four-component set, safe/distinct identifiers, private create-new output, manifest size/hash corruption detection, unsafe/duplicate member names, explicit operator gates, project separation, token-checked rollback, and absence of `down -v` or Docker-socket use.

## Disposable live recovery

Final command: `npm run production:verify:backup`  
Final fixture nonce: `0ea462414595`

The verifier:

1. created a unique source stack and registered a real account through loopback HTTP;
2. uploaded a CSV dataset, added an independent Redis marker, and added a raw Chroma record;
3. seeded a BullMQ active-list sentinel, proved backup refused before publishing a manifest, removed the exact sentinel, and proved the source login recovered;
4. created the maintenance bundle, then repeated login, dataset hash, Redis, and raw-Chroma checks against the restarted source before removing only its label-checked volumes and asserting their absence;
5. corrupted an artifact and proved refusal before any destination volume existed;
6. supplied a checksum-valid but invalid Mongo archive, drove failure after destination creation, and proved token-owned containers/networks/volumes rolled back;
7. created a foreign sentinel volume and proved restore refused and preserved it;
8. restored into a distinct new project/prefix;
9. verified the same Mongo user id, dataset SHA-256 `3e477c258574cdfe93d41a605106f1cf8a58d9dd5088ebc1386976a211845ea7`, Redis persistent value, and Chroma raw record;
10. restarted MongoDB, Redis, ChromaDB, and backend, then repeated all four semantic checks; and
11. removed every source/restore/corrupt/rollback/foreign fixture object and reconfirmed the six known pre-existing `kfive-ai_*` volume identities were unchanged.

Final structured result:

```json
{
  "mode": "offline same-datastore-image production Compose application recovery",
  "activeWorkRefusedAndSourceRecovered": true,
  "sourceUsableAfterBackup": true,
  "mongoIdentity": true,
  "uploadsDatasetSha256": "3e477c258574cdfe93d41a605106f1cf8a58d9dd5088ebc1386976a211845ea7",
  "redisPersistentState": true,
  "chromaRawRecord": true,
  "postRestartAllComponents": true,
  "corruptBundleRejectedBeforeMutation": true,
  "postMutationRollback": true,
  "foreignVolumeRefused": true,
  "protectedVolumesUnchanged": true,
  "logs": "excluded"
}
```

This host cannot apply Docker exec AppArmor profiles, so exec-based healthchecks report unhealthy despite working services. The verifier used test-only healthcheck overrides and real loopback API plus private-network protocol probes. Production restore cannot use that override and retains health-gated Mongo initialization.

## Honest boundary

This is offline, same-host/same-datastore-image application recovery. The Chroma assertion is a raw record, not a linked Mongo `RagSource` or RAG query. It does not prove hot consistency, signed/authenticated or encrypted backups, untrusted-root resistance, off-host retention, cross-version migration, remote DR, queue replay safety, Kubernetes/observability recovery, RPO/RTO, or the development laptop being unnecessary. Logs and secrets are intentionally excluded; Redis queue state requires review before workers start.
