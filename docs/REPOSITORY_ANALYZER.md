# Repository Analyzer

KFive currently provides an Experimental, deterministic, read-only analyzer for explicitly uploaded ZIP repositories. It inventories bounded archive metadata and selected `package.json` manifests; it does not clone, unpack entries to the filesystem, build, run, install, or modify repository code. Selected manifests are decompressed only into bounded backend memory.

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
- ZIP processing uses pinned `yauzl` with lazy entries, strict filenames, decoded names, and entry-size validation.
- The parser rejects traversal, absolute and drive paths, backslashes, control/format/replacement characters, normalization/case collisions, ambiguous file/directory prefixes, symlinks, devices, volume entries, encryption, unsupported flags/compression, and nested archives.
- Initial limits include 2,000 entries, 25 MiB declared expansion, 5 MiB per entry, 100:1 compression ratio, depth 30, 20 package manifests, 128 KiB per manifest, 1 MiB total manifest bytes read, and 500 retained dependencies.
- Selected manifest bytes are streamed with actual-byte limits and CRC-32 verification. No archive entry is written to disk.
- Raw archive bytes and complete file contents are not stored in MongoDB. The bounded report persists paths, inferred signals, source checksum/metadata, package names, dependency names and sanitized version specifications, and package-script names. Do not upload repositories containing secrets; this is not a secret or malware scanner.
- Every saved report is owner-scoped. Projects are organizational filters, not authorization boundaries within one owner. Project uploads require an active owned project; archived project reports remain readable.
- Unscoped history returns at most 50 recent reports for the owner, including project-associated reports; a project filter returns that exact owned project's reports. The bounded full report loads only through its owner-scoped detail endpoint.
- A process-local pre-create check normally limits each user to 100 reports, and saved reports can be explicitly deleted to recover capacity. This check is not an atomic distributed database quota.

Archive parsing still occurs inside the backend process. The limits, admission control, and rate limit reduce risk, but they do not provide the process isolation of a dedicated importer service or deployment-wide resource controls. The 15-second timer can abort asynchronous archive reads but cannot preempt synchronous event-loop work. Treat this slice as Experimental until the target-host adversarial and restart-persistence path has passed.

## API

All routes require authentication and use `/api/v1/repositories`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/status?projectId=...` | Report database availability, scope, capabilities, and limits |
| `GET` | `/analyses?projectId=...` | Return bounded owner summaries, optionally filtered to one owned project |
| `POST` | `/analyses` | Synchronously analyze one multipart `archive` ZIP with optional `name` and `projectId` |
| `GET` | `/analyses/:id` | Return one full owner-scoped report |
| `DELETE` | `/analyses/:id` | Delete only the saved report; never mutate the source repository |

## Verification status

Automated tests create real ZIP structures and cover deterministic evidence, script-command omission, credential-spec omission, Unicode controls, unsafe paths, normalization/case/prefix collisions, nested archives, symlinks, encryption, unsupported compression/flags, CRC failure, compression ratio, manifest caps, owner/project scope, deleted-project discoverability/deletion, archived deletion behavior, quota/concurrency, safe errors, response projection, upload middleware, and frontend contract validation.

Before changing the state from Experimental, execute the full browser-to-authenticated-API-to-MongoDB path with valid and hostile archives, restart the stack, verify persistence and deletion, verify a second user cannot read a report, verify project filtering for the same owner, and measure CPU/RAM behavior under the configured admission limit.

## Planned adapters and analysis

GitHub URL import, browser-selected local directories, ZIP64/multi-volume support, background importer workers, cancellation, repository RAG, AI architecture analysis, API/auth/database discovery, broken-reference analysis, documentation drift, vulnerability intelligence, and build/test execution are not implemented.
