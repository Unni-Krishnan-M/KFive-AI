# KFive AI Status

Documentation updated: 2026-08-26. Phase 9 source verification and the in-progress Phase 10 scope are included below; live-environment gaps remain explicit.

## Phase 0 result

The initial repository was not operational: both production builds failed, both test commands had zero tests, lint had no configuration, four backend models were missing, production alias resolution was broken, Compose referenced missing build files, and documentation claimed unverified production readiness. The full evidence is in [docs/AUDIT_PHASE_0.md](docs/AUDIT_PHASE_0.md).

## Phase 1 stabilization result

Completed in this slice:

- Restored frontend and backend builds.
- Added User, Conversation, Document, and Agent models.
- Added typed local/hybrid/remote environment validation and canonical `MONGODB_URL` support.
- Added shared AI provider selection with explicit no-fallback errors; Ollama is the only installed adapter.
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
| `npm run build` | Passed |
| `npm test` | Passed: 294 checks total (52 frontend, 236 backend, 6 Code Runner tests) |
| `npm run lint` | Passed |
| `bash -n setup.sh scripts/*.sh test-auth.sh` | Passed |
| `docker compose --env-file .env.example config --quiet` | Passed |
| Production backend module load | Passed with test environment |
| `npm audit` | 37 total advisories remain: 2 critical, 16 high, 17 moderate, 2 low; the two critical findings are in development tooling |
| `npm audit --omit=dev` | 22 production-tree advisories remain: 7 high, 14 moderate, 1 low, 0 critical |
| Docker image build | Passed on the user host for frontend and backend |
| Full Compose health/persistence | Blocked by an older MongoDB volume initialized with different credentials; recovery identified but not yet re-run |
| GPU access | Failed capability check; driver unavailable to this environment |

## Known limitations

Authentication, MongoDB persistence, Redis connectivity, Ollama streaming, Socket.IO, container images, browser PDF download, and the future isolated document processor still require live integration/E2E execution before being called complete. The test baseline does not yet satisfy the master platform test matrix.

Next live prerequisites: recreate the stale MongoDB volume with the current `.env`, execute the repaired local Compose/auth/chat/project persistence path, then run the mandatory Code Lab normal/timeout/cancellation/output/memory/network/filesystem isolation suite against the target Docker daemon.

## Phase 2 runtime/provider slice

Completed and locally verified in this slice:

- Added authenticated, secret-safe runtime topology at `/api/v1/settings/runtime`.
- Added provider health, model listing, and connection testing under `/api/v1/settings/providers`.
- Rebuilt Settings around backend-reported deployment mode, provider state, models, service locality, missing dependencies, and restart-required fields.
- Removed fake Settings persistence/delete actions and hard-coded Settings model data.
- Added exact configuration-missing messages for Code Runner, Document Processor, OCR, and ChromaDB.
- Buffered Ollama NDJSON across arbitrary network chunks and made malformed/truncated streams fail explicitly.
- Made unimplemented document jobs fail in BullMQ rather than appear completed.

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

Known limitation: model list/pull/delete, GPU measurement, and Chat routing are unit/integration tested with injected adapters, but their target-host end-to-end path is pending healthy Compose startup. Model benchmark history is not yet a routing input because the benchmark subsystem remains planned.

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

Automated verification covers schema validation, ownership boundaries, archived behavior, deletion token expiry/reuse, project filtering, upload cleanup, agent updates, frontend context parsing, CORS policy, builds, and lint. The browser/MongoDB persistence path is still pending recovery of the host's stale credential volume, so Project Rooms remain **Experimental** rather than Implemented.

## Phase 5 Code Lab slice

Completed and locally source-verified in this slice:

- Added an authenticated, owner/project-scoped Code Run API and persistent run history for Python 3.12 and JavaScript 22.
- Added a real Code Lab UI with runtime availability, source/stdin, run/stop, bounded status polling, manual refresh, stdout/stderr, exit/duration and reported runner diagnostics. It never evaluates code in the browser or backend process.
- Added a dedicated BullMQ broker which creates disposable runtime containers through structured Docker CLI arguments. User programs receive no Docker socket, host mount, network, capabilities, or root user and have fixed CPU, RAM, PID, temporary-storage, output, and execution-time limits.
- Added cancellation, timeout/output/OOM states, safe cleanup, a credential-safe Redis heartbeat, missed-event replay, periodic stuck-run reconciliation, runner-result identity validation, and label-scoped stale-container cleanup.
- Added the disabled-by-default `code-lab` Compose profile. Startup validates the exact socket group and refuses to pull runtime images during a request.
- Removed fabricated Workspace AI output, fake document upload progress/context actions, unsupported social-login controls, and false demo credential guidance.

Code Lab remains **Experimental**. The frontend/backend/broker builds, current 294 automated checks, default/profile Compose rendering, shell syntax, and diff checks pass, but this environment cannot access the host Docker socket. The target-host isolation suite and immutable runtime digest selection remain mandatory before calling the critical path complete. Broker access to a Docker daemon is privileged infrastructure access; a dedicated or rootless daemon is recommended.

## Phase 6 Document Studio slice

Completed and locally source-verified in this slice:

- Replaced the broad File Actions mock with three real browser-local PDF utilities: ordered merge, selected-page extraction, and selected-page rotation.
- Added strict PDF filename/media/signature checks; 25 MiB per-file, 75 MiB aggregate, 10-file, 500-page, and 100 MiB output limits; encrypted/malformed handling; ordered page-expression parsing; and stable actionable error codes.
- Tests generate real PDFs, execute each operation, reload every output with `pdf-lib`, and verify page order/count/rotation, caller-byte immutability, selection rules, and limit/error branches.
- PDF inputs remain in the browser and results download locally. The UI states that outputs are not persisted to Documents or Projects, uses indeterminate processing rather than invented percentages, and revokes result object URLs.
- Removed unsupported Office/image conversion tiles, search entries, and the disconnected Resume Actions route from shipped navigation.
- Disabled native LibreOffice/Poppler execution in the backend API. `/api/v1/documents/convert` now returns authenticated `503 DOCUMENT_PROCESSOR_UNAVAILABLE` without multipart/native parser middleware.
- Document upload/list responses no longer expose internal paths, filenames, content, user IDs, or raw processor errors. Failed DB creation cleans uploaded files; queue failure becomes an explicit failed state; deletion is owner-scoped, blocks active processing, validates upload-root containment, and uses asynchronous cleanup.

The PDF utility slice remains **Experimental** until its actual browser select/process/download path is smoke-tested. Server-side conversion, PDF preview/thumbnails, compression, images, page reordering/deletion/duplication, watermark/page numbers, batch jobs, OCR, and Office conversion remain Planned. A future native Document Processor must be a separate constrained service; untrusted documents will not be parsed inside the backend process.

## Phase 7 Knowledge / RAG slice

Completed and locally source-verified in this slice:

- Added a distinct `AI_EMBEDDING_MODEL`; the chat model is never substituted for missing embedding configuration.
- Added a bounded ChromaDB 0.4.24 client for heartbeat, collection, upsert, query, and owner-filtered deletion with strict response validation and fixed, non-leaking errors.
- Added owner/workspace/project-scoped metadata, synchronous UTF-8 TXT/Markdown ingestion, normalized overlapping chunks, batched embeddings, partial-vector cleanup, and explicit provider/model/dimension/chunking mismatch errors.
- Added retrieval with both Chroma owner/scope filters and post-retrieval validation against ready MongoDB source records. Raw Chroma distance is returned; no fabricated relevance score is produced.
- Treats retrieved content and source labels as untrusted prompt data, rejects control characters in labels, and returns source markers and bounded excerpts derived by the backend.
- Added a Project-aware Knowledge page with exact dependency failures, UTF-8 file validation, bounded refresh, archived read/query behavior, retrieved-source inspection, and no fabricated availability.

Knowledge/RAG remains **Experimental**. Automated tests exercise its core contracts and attack boundaries, but this environment has not executed the critical MongoDB + ChromaDB + embedding-capable provider ingestion/query/delete/restart path. PDF/DOCX/OCR ingestion, page references, reranking, repository knowledge, background indexing, and conversational RAG memory remain Planned. See [docs/RAG.md](docs/RAG.md).

## Phase 8 Repository Analyzer slice

Completed and locally source-verified in this slice:

- Added authenticated, owner/project-scoped create, list, detail, status, and guarded deletion APIs for deterministic ZIP reports.
- Added a project-aware Repository Analyzer page with bounded ZIP prechecks, exact evidence views, explicit full-report loading, JSON export, archived-project read-only behavior, and stale-request protection.
- Added strict in-memory ZIP admission and parsing limits: 10 MiB upload, 2,000 entries, 25 MiB declared uncompressed data, 5 MiB per entry, 100:1 compression ratio, bounded paths/manifests/dependencies, two concurrent analyses, two uploads per minute, and a 15-second timeout.
- Rejects encrypted, multi-volume, nested-archive, traversal/absolute/backslash/control/ambiguous/colliding/symlink/device archives; reads only selected bounded `package.json` manifests and verifies their CRC32. It never extracts files, runs code or package scripts, installs dependencies, writes repository contents, or performs network access.
- Stores only bounded analysis metadata/evidence and package-script names, never uploaded ZIP bytes, complete file contents, script commands, credential-bearing dependency specifications, owner IDs, or internal database fields in public responses.
- Unscoped history includes all owner reports so deleting a project cannot strand its analyzer records; project-filtered history remains exact and archived project records remain read-only.
- Added a 100-report per-user retention cap with authenticated deletion to recover capacity.

Repository Analyzer remains **Experimental**. Parsing still occurs in the backend process, and this environment has not executed the browser-to-authenticated-API-to-MongoDB persistence/restart path or target-host adversarial CPU/RAM measurements. GitHub URL import, selected local directories, repository RAG, AI architecture analysis, and build/test execution remain Planned. See [docs/REPOSITORY_ANALYZER.md](docs/REPOSITORY_ANALYZER.md).

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

Implementation is in progress for this deliberately fixed workflow:

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

Phase 10 remains **Experimental and in progress**. Do not treat the fixed graph as complete until the source integration finishes and the target-host browser/authenticated API/configured-provider SSE/MongoDB persistence path, including archived behavior, cancellation, bounds, history/detail, and terminal deletion, is exercised. See [docs/WORKFLOWS.md](docs/WORKFLOWS.md).
