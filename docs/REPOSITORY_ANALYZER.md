# Repository Analyzer

KFive currently provides an Experimental, deterministic, read-only analyzer for explicitly uploaded ZIP repositories. It inventories bounded archive metadata and selected `package.json` manifests; it does not clone, unpack entries to the filesystem, build, run, install, or modify repository code. Selected manifests are decompressed only into bounded child-process memory.

## Current report

The persisted report can include:

- A bounded repository tree and declared sizes.
- Language counts inferred from fixed file-extension evidence.
- Declared npm dependency names, bounded non-credential-bearing version specifications, and dependency groups. Credential-bearing specifications are omitted with a generic warning.
- Package script names only. Script command values are never retained or returned.
- Framework and tool signals tied to the dependency and manifest path that produced them.
- Test, Dockerfile, Compose, CI, Kubernetes, and high-confidence sensitive-filename signals.
- Safe warnings for malformed or truncated manifest evidence.

These are deterministic signals, not claims that a project is secure, runnable, Docker-ready, Kubernetes-ready, or architecturally correct.

## Security boundaries

- Multer buffers each archive completely in backend RAM. Upload is limited to 10 MiB and two admitted analyses per backend process, with an additional authenticated-owner-keyed two-per-minute limiter held in process memory.
- Source/test/Kubernetes process mode launches one fixed Node worker per admitted ZIP. Local and production Compose instead send one exact versioned binary frame over a fixed Unix socket to a dedicated importer, which launches that same one-shot worker. The worker receives only `NODE_ENV=production`, uses 96 MiB V8 old space plus 8 MiB semi-space, caps response bytes at 4 MiB, discards stderr, has a hard kill deadline, reconstructs only allowlisted archive errors, and returns a report whose source metadata/SHA-256 is checked against the original request before persistence.
- ZIP processing uses pinned `yauzl` with lazy entries, strict filenames, decoded names, and entry-size validation.
- Classic ZIP end discovery scans only the specification's final 65,557-byte window. One shared inspector admits at most eight structurally plausible EOCD candidates and 2,001 cumulative central-header visits, requires exactly one fully validated single-disk interpretation, derives encryption state from it, and sanitizes only its encoded comment span.
- ZIP64 sentinels, multi-disk metadata, multiple coherent end-record interpretations, and work-budget exhaustion fail closed. Comments containing a second structurally coherent ZIP interpretation are deliberately rejected; ordinary comments up to the classic 65,535-byte maximum remain supported.
- The parser rejects traversal, absolute and drive paths, backslashes, control/format/replacement characters, normalization/case collisions, ambiguous file/directory prefixes, symlinks, devices, volume entries, encryption, unsupported flags/compression, and nested archives.
- Initial limits include 2,000 entries, 25 MiB declared expansion, 5 MiB per entry, 100:1 compression ratio, depth 30, 20 package manifests, 128 KiB per manifest, 1 MiB total manifest bytes read, and 500 retained dependencies.
- Selected manifest bytes are streamed with actual-byte limits and CRC-32 verification. No archive entry is written to disk.
- Raw archive bytes and complete file contents are not stored in MongoDB. The bounded report persists paths, inferred signals, source checksum/metadata, package names, dependency names and sanitized version specifications, and package-script names. Do not upload repositories containing secrets; this is not a secret or malware scanner.
- Every saved report is owner-scoped. Projects are organizational filters, not authorization boundaries within one owner. Project uploads require an active owned project; publication and deletion recheck that state under the shared in-process project mutation lease. Archived project reports remain readable.
- Workspace and project histories are disjoint. Unscoped history returns 50-item pages of workspace-only reports; a project filter paginates that exact owned project's reports. Stable descending creation time plus database ID ordering prevents duplicates or gaps among equal timestamps. The bounded full report loads only through its owner-scoped detail endpoint.
- Deleting a project preserves its reports. From workspace history, **Reports from deleted projects** opens recovery history (`GET /api/v1/repositories/analyses?scope=orphaned`), where owners can read, export, and explicitly delete those reports without remembering the deleted project ID. Existing active/archived project reports are excluded. The recovery query cannot be combined with `projectId`; uploads are disabled in this view. Recovery reads owner-scope before joining project existence and return bounded 50-item pages.
- A process-local pre-create check normally limits each user to 100 reports, and saved reports can be explicitly deleted to recover capacity. This check is not an atomic distributed database quota.

Archive parsing occurs in a separate one-shot process, so ordinary parser synchronous work, hangs, and crashes do not run on or terminate the backend event loop. In local and production Compose that process is a child of a dedicated importer running as `10001:10002` over a fixed `0660` socket. The backend mounts the socket volume read-only and joins only group `10002`; the importer has no network, secrets, application data, Docker socket, or published port, and runs with a read-only root, a bounded no-exec tmpfs, all capabilities dropped, no-new-privileges, zero core dumps, and 1 CPU/512 MiB/48-PID limits. It accepts at most two active parser children. Client disconnect/deadline and daemon shutdown abort the exact child. Startup accepts only the fixed socket path, validates parent/socket type, owner, group, mode and inode, refuses an active or foreign path, and removes only a revalidated stale socket. Post-bind hardening failure closes the listener and removes only the exact created inode.

Socket mode is explicit and never falls back to same-process parsing. An absent importer makes `/repositories/status` report its dependency unavailable and `canAnalyze: false`; new uploads return fixed `503 REPOSITORY_ANALYZER_UNAVAILABLE` before persistence, while list/detail/delete remain database-only. The socket volume is ephemeral and excluded from production backup/restore sets. Kubernetes still uses the process adapter and has not passed the dedicated importer boundary.

This is a materially stronger local/production Compose boundary, not a complete production security sandbox or hostile-resource certification. V8 heap flags do not cap all native/Buffer allocation; broader CPU/native-memory/concurrency proof remains. Response validation is exact, bounded, and request-provenance checked, but it is not an independent semantic re-analysis of every aggregate. Project leases/retention are still process-local. History pagination remains live-verified for the full 100-report quota. These limits keep the overall feature Experimental.

## API

All routes require authentication and use `/api/v1/repositories`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/status?projectId=...` | Report database availability, scope, capabilities, and limits |
| `GET` | `/analyses?page=...&projectId=...` | Return one 50-item page of owner summaries, optionally filtered to one owned project |
| `GET` | `/analyses?page=...&scope=orphaned` | Paginate owner reports whose project was deleted; cannot combine with `projectId` |
| `POST` | `/analyses` | Synchronously analyze one multipart `archive` ZIP with optional `name` and `projectId` |
| `GET` | `/analyses/:id` | Return one full owner-scoped report |
| `DELETE` | `/analyses/:id` | Delete only the saved report; never mutate the source repository |

## Verification status

Automated tests create real ZIP structures and cover deterministic evidence, script-command omission, credential-spec omission, Unicode controls, unsafe paths, normalization/case/prefix collisions, nested archives, symlinks, encryption, unsupported compression/flags, CRC failure, compression ratio, manifest caps, owner/project scope, deleted-project discoverability/deletion, archived deletion behavior, quota/concurrency, safe errors, response projection, upload middleware, and frontend contract validation.

Live browser/API/MongoDB verification on 2026-09-15 passed workspace and project ZIP upload, JSON export, disjoint histories, refreshed archive restrictions, second-user denial (404), traversal rejection (400), restart persistence, and report deletion. Deleting a disposable project preserved its report; recovery history successfully listed, opened, exported, and deleted it. Export content remained identical after restart and project deletion. Disposable test accounts, project, and reports were removed; export evidence remains in `output/playwright/.playwright-cli/`.

On 2026-11-05, a second disposable run seeded 100 equal-timestamp reports and proved exact two-page ordering and totals through workspace, project, and orphan scopes. Canonical invalid/repeated/out-of-range pages failed closed, another owner saw zero reports, and a real Chrome session navigated to page 2 and loaded report 049 detail with zero console errors. Exact cleanup and persistent-volume identity checks passed. See `output/verification/repository-pagination-live.md`.

Also on 2026-11-05, review-driven TDD reproduced a synchronous EOCD-candidate amplification at roughly 24 seconds for a 3.08 MiB malformed input. The final built-code verifier rejected the same 65,534-header/2,978-candidate shape in 0.356 ms with 0.381 ms timer lag; deterministic unit coverage enforces the explicit header-work budget independently of timing. See `output/verification/repository-archive-end-record-live.md`.

On 2026-11-06, focused TDD, compiled-process verification, the final Compose image, and a hardened disposable-image run passed the child-process slice. Two valid archives ran concurrently in distinct children while the parent heartbeat advanced; an encrypted archive preserved its canonical typed error and no child remained. The real frontend-proxy/API path persisted and retrieved a checksum-matched report, rejected encrypted input without persistence, deleted the report and nonce-scoped account, retained readiness, and preserved all six protected volume identities. The same image ran two children under explicit network-none/read-only/capability/PID/memory/CPU controls. Those disposable controls are not claimed for normal Compose. See `output/verification/repository-importer-process-live.md`.

On 2026-11-13, the real local Compose frontend-proxy/API/Unix-socket path passed the dedicated importer slice. Runtime inspection proved the fixed non-root identity, network-none attachment with no routable address or TCP listener, read-only root, one socket-only volume, no secrets or Docker socket, bounded resources, and a `0660` socket. A valid report persisted; encrypted input did not. After importer SIGKILL, status became unavailable, upload returned the fixed 503 without persistence, and the existing report stayed readable. Restart safely recovered the stale socket, a 2,000-entry upload exposed its transient child only under the importer, backend/importer restart retained both reports, logs omitted nonce/filenames/content, exact cleanup removed two users and all reports, and all six protected volumes plus the socket-volume identity were unchanged. See `output/verification/repository-importer-container-live.md`.

This testing exposed and repaired the multipart part-count boundary that rejected the frontend's archive/name/project upload, wrapped-directory GitHub CI detection, and stale archive-state mutation controls. Automated regressions also cover project deletion/archive while an analysis is running.

Retained export SHA-256 checksums:

- `kfive-repository-e2e-20260909-analysis.json`: `78ffced114012df51fca5ba90a3cb3303976dc29cf30df52a578d77ad3b586b2`.
- `kfive-repo-20260915-analysis.json`: `a4ff9bb05549328c09c2e93afa3155ff2cd2ba09c4629de6db138d2ecc373754`.

Broader CPU/native-memory behavior under adversarial expansion and concurrent admission remains unverified. Do not infer Kubernetes isolation, production certification, or complete repository intelligence from these local checks.

## Planned adapters and analysis

GitHub URL import, browser-selected local directories, ZIP64/multi-volume support, background importer workers, cancellation, repository RAG, AI architecture analysis, API/auth/database discovery, broken-reference analysis, documentation drift, vulnerability intelligence, and build/test execution are not implemented.
