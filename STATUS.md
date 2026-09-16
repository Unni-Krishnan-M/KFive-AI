# KFive AI Status

## 2026-09-16 RAG lifecycle follow-up

- Fixed mixed-case ObjectId divergence between MongoDB and case-sensitive vector metadata/collection hashes.
- Recheck project state under the shared in-process mutation lease before creating indexing metadata and publishing ready sources. Archive/delete during indexing triggers cleanup and failed metadata instead of ready publication.
- Indexing-source deletion now returns a structured `409 RAG_SOURCE_BUSY`; refreshed server archive state controls the Knowledge page's mutation buttons and banner.
- Verification: backend **71 suites / 453 tests passed**, frontend **18 files / 103 tests passed**, all lint targets passed, and frontend/backend production Compose builds and startup passed. These regression tests use controlled provider/vector implementations; they do not prove live embeddings or distributed concurrency safety.
- Runtime diagnosis: embedding model remains unset; the backend's configured Ollama connection failed, while host Ollama was active on loopback only. No AI/network configuration was changed. Full ingestion/query E2E, deleted-project knowledge recovery, and indexing crash reconciliation remain outstanding. See [RAG](docs/RAG.md).

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
| `npm audit` | 37 total advisories remain: 2 critical, 16 high, 17 moderate, 2 low; the two critical findings are in development tooling |
| `npm audit --omit=dev` | 22 production-tree advisories remain: 7 high, 14 moderate, 1 low, 0 critical |
| Docker image build | Passed on the user host for frontend, backend, benchmark/notebook workers, and both notebook image targets; the image test stage runs all 68 runtime checks |
| Local Compose health/persistence | Frontend, backend, MongoDB, Redis, ChromaDB, and benchmark worker rebuilt and started; Notebook run/history, Chat timeout/Stop records, Project/document/Dataset data, a completed Benchmark, and Repository Analyzer reports passed restart/reload persistence checks |
| GPU access | Failed capability check; driver unavailable to this environment |

## Known limitations

The Notebook Mode authenticated MongoDB/Redis/Docker path is live-verified through both its API and real browser UI. Chat's strict input boundary, provider-timeout persistence, explicit Stop/cancellation, safe terminal messages, provider/model/latency display, and Mongo-backed reload path also passed in a real browser. The Project Room core lifecycle, second-user ownership boundary, project-document archive/restore behavior, restart persistence, and guarded deletion passed against the production Compose frontend/backend/MongoDB path. All three currently exposed browser PDF operations produced downloaded files whose bytes were independently reopened and checked. Dataset Lab's core CSV lifecycle and boundaries passed the same live stack. Model Benchmarks now has one successful real browser/provider/Redis/worker/Mongo six-call run plus cancellation, export, completed-run restart persistence, scope separation, and archive-guard evidence. Successful Chat token streaming through the standard host listener, the full login/refresh/expiry/revocation and Socket.IO matrices, Code Lab host isolation, hostile Dataset resource tests, the remaining Project/Document/Dataset features, and a future isolated document processor still require their own complete integration/E2E execution. The test baseline does not yet satisfy the master platform test matrix.

Next live priorities: make host Ollama reachable to Docker and execute successful Chat token streaming, complete the login/refresh matrix, immutable-lock and harden Notebook Mode on an AppArmor-capable host, complete the remaining Benchmark GPU/remote/second-user/active-recovery paths, and run the mandatory Code Lab normal/timeout/cancellation/output/memory/network/filesystem paths against its real worker.

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

Code Lab remains **Experimental**. The frontend/backend/broker builds, current 600 passed automated checks plus three notebook-runtime host skips, default/profile Compose rendering, shell syntax, and diff checks pass, but its separate target-host isolation suite and immutable runtime digest selection remain mandatory before calling the critical path complete. Broker access to a Docker daemon is privileged infrastructure access; a dedicated or rootless daemon is recommended.

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
- Document upload/list responses no longer expose internal paths, filenames, content, user IDs, or raw processor errors. Failed DB creation cleans uploaded files; uploads become an explicit processor-unavailable failed state without an in-process fake worker; deletion is owner-scoped, blocks active processing, validates upload-root containment, and uses asynchronous cleanup.

The current three-operation PDF utility surface is **Implemented**: a production-Compose real-auth browser run selected local fixtures, downloaded merge/extract/rotate outputs through their real Blob links, and independently verified `%PDF-` bytes, page count/order/dimensions, and rotation. Overall Document Studio remains **Experimental**. Server-side processing/conversion, PDF preview/thumbnails, compression, images, page reordering/deletion/duplication, watermark/page numbers, batch jobs, OCR, and Office conversion remain Planned. A future native Document Processor must be a separate constrained service; untrusted documents will not be parsed inside the backend process.

## Phase 7 Knowledge / RAG slice

Completed and locally source-verified in this slice:

- Added a distinct `AI_EMBEDDING_MODEL`; the chat model is never substituted for missing embedding configuration.
- Added a bounded ChromaDB 0.4.24 client for heartbeat, collection, upsert, query, and owner-filtered deletion with strict response validation and fixed, non-leaking errors.
- Added owner/workspace/project-scoped metadata, synchronous UTF-8 TXT/Markdown ingestion, normalized overlapping chunks, batched embeddings, partial-vector cleanup, and explicit provider/model/dimension/chunking mismatch errors.
- Added retrieval with both Chroma owner/scope filters and post-retrieval validation against ready MongoDB source records. Raw Chroma distance is returned; no fabricated relevance score is produced.
- Treats retrieved content and source labels as untrusted prompt data, rejects control characters in labels, and returns source markers and bounded excerpts derived by the backend.
- Added a Project-aware Knowledge page with exact dependency failures, UTF-8 file validation, bounded refresh, archived read/query behavior, retrieved-source inspection, and no fabricated availability.

Status now skips provider discovery when the embedding model is absent or embeddings are unsupported; otherwise discovery shares a five-second deadline. On 2026-09-15 the live status endpoint reported reachable ChromaDB and explicit missing embedding configuration, without a provider probe. That request and a persisted Repository Analyzer report fetch completed together in 33 ms; this is not an ingestion/query benchmark.

Knowledge/RAG remains **Experimental**. Automated tests exercise its core contracts and attack boundaries, but this environment has not executed the critical MongoDB + ChromaDB + embedding-capable provider ingestion/query/delete/restart path; an embedding model is not configured. PDF/DOCX/OCR ingestion, page references, reranking, repository knowledge, background indexing, and conversational RAG memory remain Planned. See [docs/RAG.md](docs/RAG.md).

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

Production-Compose browser verification completed on 2026-09-15: workspace/project ZIP uploads returned 201, exports worked, archive refresh disabled mutations, workspace/project lists stayed disjoint, and a second user received 404 for a foreign report. A traversal ZIP returned 400. Reports survived restart; after deleting the disposable project, its recovery-view report could still be listed, opened, exported with an identical checksum, and deleted. Only disposable test users/projects/reports were cleaned up; report exports were retained as evidence.

Repository Analyzer remains **Experimental**. Parsing still occurs in the backend process; target-host adversarial CPU/RAM measurements and isolated processing remain pending. Lists are capped at 50 while the owner quota is 100, and pagination is not implemented. Project leases are not distributed. GitHub URL import, selected local directories, repository RAG, AI architecture analysis, and build/test execution remain Planned. See [docs/REPOSITORY_ANALYZER.md](docs/REPOSITORY_ANALYZER.md).

## Phase 9 Agent Runtime slice

Implemented in this source slice:

- Added a persistent, owner/agent/project-scoped `AgentRun` record with bounded prompt and output, provider/model/usage metadata, safe error states, timestamps, and a bounded lifecycle audit timeline.
- Added authenticated paginated run-list, detail, SSE execution, idempotent cancellation, and terminal-run deletion APIs. Startup and 30-second periodic reconciliation mark sufficiently stale active records `interrupted`; they do not resume them.
- Snapshotted the agent name, requested model, temperature, empty tool list, and system-prompt hash so later agent edits do not rewrite historical run metadata.
- Enforced safe UTF-8 prompt validation, output and history bounds, a runtime timeout, owner-scoped reads, archived-project read-only behavior, and guarded agent deletion so audit records are not orphaned.
- Added the browser history/detail/timeline view, 50-record pagination, confirmed terminal-run deletion, and a 500-retained-run owner cap.
- Kept the agent tool allowlist empty. Non-empty tool configuration is rejected and the provider request contains no tool definitions, so this slice performs no filesystem, command, network-tool, or third-party write actions.

The Phase 9 slice remains **Experimental**. The active-run registry, one-run-per-owner rule, execution lease, abort controllers, and count-then-create retention enforcement are held in one backend process; they do not coordinate multiple replicas, survive restart, deliver cancellation across processes, or provide an atomic distributed quota. No approval layer is needed while tools remain disabled, but write-capable tools must not be added without server-enforced authorization, validation, audit, and consequence-appropriate approvals.

Run detail intentionally persists and returns the normalized prompt and generated output. Terminal-run deletion and a 500-run owner cap are present, but there is no age-based retention, bulk purge, redaction, or application-level encryption control, so prompts must not contain secrets. The target-host configured-provider, MongoDB persistence/restart, cancellation/timeout, and browser E2E paths remain pending. See [docs/AGENTS.md](docs/AGENTS.md).

## Phase 10 Experimental Workflow slice

Implemented and source-verified as this deliberately fixed workflow:

```text
Input -> Prompt -> LLM -> Output
```

The Phase 10 contract is limited to:

- owner-scoped workflow definitions with server-validated optional project context;
- mutation and execution for active-project workflows, with archived-project definitions and run history read-only except that an already-active or orphaned run may be cancelled as a safe-shutdown action;
- provider-neutral SSE text generation whose output is always inert and is never executed;
- persistent bounded run summaries, owner-scoped detail, cancellation, lifecycle timelines, and explicit terminal-run deletion;
- 16 KiB input, prompt-template, and system-prompt limits, a 256 KiB output limit, a 30-second timeout, a 100-definition and 500-run owner retention cap, pages of at most 50 summaries over at most ten pages, and at most 50 timeline events; and
- one process-local active workflow run per owner. Definition and run retention use non-atomic count-then-create checks that are not multi-replica quotas; Workflow and Agent leases are separate and do not form a shared GPU queue.

This is not a general workflow or automation engine. Tool, shell, code-runner, agent, RAG, Knowledge, document, PDF, OCR, repository, action, branching, loop, and arbitrary-node execution are outside this slice. Inputs, outputs, prompt templates, and system prompts are retained as application-readable plaintext, and each run snapshots the full definition including its template and system prompt; they must not contain secrets or regulated data.

Focused Phase 10 verification passes 30 backend tests and 7 frontend contract tests. See the current repository-wide verification table above; the workflow browser/provider/Mongo path remains pending.

Phase 10 remains **Experimental**. Do not call its critical path complete until the target-host browser/authenticated API/configured-provider SSE/MongoDB persistence path, including archived behavior, cancellation, bounds, history/detail, and terminal deletion, is exercised. See [docs/WORKFLOWS.md](docs/WORKFLOWS.md).

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
