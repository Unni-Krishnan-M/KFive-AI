# KFive AI

KFive AI is an existing browser-based, local-first AI workspace under active development. This repository is being repaired and extended incrementally; it is not yet the complete platform described in the roadmap.

## Verified baseline

Latest focused follow-up (2026-11-13): local and production Compose now route Repository Analyzer parsing over a fixed, group-restricted Unix socket to a dedicated non-root importer container with no network, a read-only root, bounded tmpfs/CPU/memory/PIDs, dropped capabilities, and one bounded parser child per request. The real frontend-proxy/API path passed valid/encrypted uploads, importer SIGKILL and stale-socket recovery, fixed unavailable status/503 without persistence, existing-report reads while offline, child ownership, backend/importer restart persistence, exact cleanup, log non-disclosure, and unchanged protected volume identities ([evidence](output/verification/repository-importer-container-live.md)). The overall feature remains Experimental pending broader hostile native-memory/CPU/concurrency proof and stronger cross-field report validation. The supported Python/JavaScript Code Lab critical path remains Complete. See [STATUS.md](STATUS.md).

As of 2026-09-15:

- Frontend production TypeScript/Vite build passes.
- Backend TypeScript build passes and emitted `@/` imports are rewritten for production execution.
- Frontend tests pass (101 tests across 18 files).
- Backend tests pass (445 tests across 71 suites, run serially).
- Code Runner tests pass (6 Node tests).
- Notebook-runtime host tests define 68 checks: 65 pass and three real-kernel/image checks skip because their dependencies are image-only; the 2026-09-02 Docker image build executed all 68 successfully.
- All lint targets pass. The separately executed test-script components total 617 passes and three intentional image-only skips.
- Docker Compose configuration validates with explicit environment input.
- The local Compose frontend, backend, MongoDB, Redis, ChromaDB, and benchmark worker rebuild and start cleanly; Notebook, Chat, Project Room, project-document, Dataset, completed Benchmark, and Repository Analyzer persistence paths have been verified across a backend or application restart where applicable.
- NVIDIA GPU access is not verified; `nvidia-smi` cannot communicate with the driver in this environment.

See [STATUS.md](STATUS.md), [Project Rooms](docs/PROJECTS.md), [Experimental Workflows](docs/WORKFLOWS.md), [Dataset Lab](docs/DATASETS.md), [Model Benchmarks](docs/BENCHMARKS.md), [Notebook Mode](docs/NOTEBOOKS.md), [Kubernetes](docs/KUBERNETES.md), [Observability](docs/OBSERVABILITY.md), [Remote deployment](docs/REMOTE_DEPLOYMENT.md), and [docs/AUDIT_PHASE_0.md](docs/AUDIT_PHASE_0.md) for the evidence and limitations.

## Current feature states

Complete means the explicitly scoped critical acceptance path has passed end to end. Implemented means the listed feature surface has executed its critical end-to-end path successfully. Experimental means code exists, sometimes with partial live evidence, but important paths, features, or hardening remain unverified or incomplete. Planned means it must not be represented as working.

| Area | State | Notes |
| --- | --- | --- |
| Frontend shell, auth UI, dashboard | Experimental | Registration, authenticated dashboard/navigation, and sign-out passed in a real browser; broader route E2E remains |
| JWT auth backend and user model | Experimental | Bounded local cookie transport, natural access-expiry/recovery, presented expired-refresh cleanup, exact presented-predecessor revocation on browser replacement, and two-tab Chromium/Web Locks coordination are Implemented. Early access revocation, background sweeping, reset/MFA, token families/reuse detection, no-Web-Locks/broader-browser, and remote/multi-replica matrices remain |
| Chat persistence and provider streaming | Experimental | Durable timeout/Stop outcomes and reload persistence passed in a real browser; successful Ollama token streaming still awaits host listener access |
| Runtime mode/provider Settings | Experimental | Secret-safe topology, connection tests, bounded provider discovery, and adapters are tested; standard host-provider switching and external-provider E2E remain pending |
| Models, GPU status, smart routing | Experimental | Catalog, routing, pull/delete safety, and GPU parsing are tested; host Ollama management E2E pending |
| MongoDB/Redis configuration | Experimental | URL wiring and the Notebook Mode persistence/queue path passed live; the full platform persistence matrix remains pending |
| Dependency readiness reporting | Experimental | Unit-tested unavailable states; complete live transitions pending |
| Document storage | Experimental | Owner/project-scoped upload/list/detail, isolated PDF extraction, bounded PNG/JPEG/scanned-PDF OCR, restart persistence, archive guards, and explicit dependency failures passed live |
| PDF Utilities | Implemented | Six browser-local structural operations—merge, extract, rotate, delete, reorder, duplicate—have verified output paths; the larger Document Studio remains Experimental |
| Agents | Experimental | The local single-replica runtime is Implemented after real browser Ollama success/cancel, Mongo history/deletion, and backend-restart persistence; tools/approvals and distributed/remote execution remain absent or unverified |
| Code Lab | Complete | Supported Python/JavaScript critical path passed real browser run/cancel through Redis → worker → disposable Docker runtime → MongoDB, including restart persistence; other requested languages and immutable image digests remain outside this claim |
| Project Rooms | Experimental | Core CRUD/tags/activity/archive/restore/guarded deletion, restart persistence, project documents, and cross-owner rejection passed live; export/import and the complete associated-resource matrix remain planned or unverified |
| Knowledge / RAG | Experimental | TXT/Markdown and stored PDF/OCR snapshot paths passed real Ollama/Chroma/Mongo/browser E2E; synchronous indexing recovery, pagination/quotas, reranking, DOCX/repository ingestion, and remote/Kubernetes proof remain |
| Repository Analyzer | Experimental | Browser ZIP upload/export, deterministic 100-report paginated history, bounded classic-ZIP end discovery, dedicated network-disabled/non-root Compose importer isolation, scope/archive guards, unavailable/recovery behavior, second-user rejection, traversal rejection, restart persistence, deleted-project recovery, and deletion passed; broader hostile-resource proof, stronger semantic response consistency, Kubernetes importer isolation, and broader import/analysis features remain |
| Workflows | Experimental | Local single-replica fixed Input -> Prompt -> LLM -> Output path is Implemented after real browser Ollama success/cancel and Mongo restart persistence; general nodes, distributed execution, project/archive live acceptance, and remote/Kubernetes proof remain |
| Dataset Lab | Experimental | CSV upload/analysis, immutable derivation/download, workspace/project separation, archive guards, restart persistence, deletion order, and second-user isolation passed production-Compose browser E2E; charts, ML recommendations, and hostile-resource proof remain |
| Model Benchmarks | Experimental | A real browser completed `chat-core-v1` 6/6 through Ollama, Redis, the worker, and MongoDB; cancellation, restart persistence, scope/archive guards, and JSON export also passed, while GPU/remote/multi-replica/second-user paths remain |
| Notebook Mode | Experimental | Authenticated editing, durable runs, opt-in broker, disposable Python runtime, stop/remove-before-verify ordering, independent verifier, cancellation, history, and restart persistence passed locally; production AppArmor/remote/Kubernetes proof remains |
| OCR | Experimental | Bounded English PNG/JPEG and raster-only PDF ingestion plus stored OCR-to-RAG page references passed production API/browser/restart verification; searchable PDFs, queues/progress/cancel, batch OCR, and remote security remain |
| ML experiments | Planned | Model training, experiment tracking, and a general shared GPU queue are not implemented |
| Kubernetes / Traefik | Experimental | Bounded local kind core passed tokenless static Traefik routing, auth, Socket.IO, host-Ollama chat, bridge restart, Mongo/backend restart persistence, and a default-deny declared service graph; worker services, TLS, backup/restore, remote CNI behavior, and remote clusters remain unverified |
| Observability | Experimental | Opt-in local-kind Prometheus/Grafana/Alertmanager/tokenless Fluent Bit/Loki passed bounded metrics, independent Mongo/Redis/Chroma reachability, CPU-only GPU state, searchable logs, restart recovery, dashboard rendering, alert delivery, and default-deny policy regressions; a separate secret-backed Datadog overlay passed correlated private-receiver gzip/credential/dual-sink verification, while operational paging, deep metrics, real GPU/SaaS acceptance, and remote durability remain bounded |
| Argo CD | Experimental | Separate infrastructure/application Applications passed ordered disposable-kind sync, self-heal, safe application pruning, controller restart, and PVC/Secret preservation; remote Git/cluster operation remains unverified |
| Remote deployment | Experimental | Production Compose passed isolated browser/provider, Hybrid outage/recovery, restart/recreation persistence, fresh-volume recovery, private-CA TLS/proxy routing, and a bounded authenticated Mongo-read burst floor; real remote host/provider, public DNS/TLS trust and certificate lifecycle, off-host DR, sustained/mixed sizing, and laptop-independence remain unverified |

## Local development

Requirements: Node.js 22+, npm, Docker Compose v2 for the full stack, and Ollama only when using the Ollama provider.

```bash
./setup.sh
npm test
npm run lint
npm run build
```

For the Compose stack, copy `.env.example` to `.env`, replace every required placeholder with random values, then run:

```bash
./scripts/kfive-up.sh
./scripts/kfive-status.sh
./scripts/kfive-logs.sh
./scripts/kfive-down.sh
```

Code Lab is disabled during normal startup. After reviewing [the Code Lab security model](docs/CODE_LAB.md), configuring the Docker socket path/group, and pre-pulling the allowlisted runtime images, opt in explicitly:

```bash
./scripts/kfive-up.sh --with-code-lab
./scripts/kfive-status.sh --with-code-lab
```

Notebook execution is also disabled during normal startup. Review [Notebook Mode](docs/NOTEBOOKS.md), configure `NOTEBOOK_DOCKER_GID`, and opt in explicitly:

```bash
./scripts/kfive-up.sh --with-notebook
./scripts/kfive-status.sh --with-notebook
```

Normal shutdown preserves named volumes. `kfive-reset.sh` refuses to delete data unless `--delete-data` is supplied and an interactive confirmation is entered.

The separate Phase 14 production-Compose foundation is documented in [Remote deployment](docs/REMOTE_DEPLOYMENT.md), [Production TLS edge](docs/TLS.md), and the [deployment acceptance matrix](docs/DEPLOYMENT_ACCEPTANCE_MATRIX.md). It accepts digest-pinned images, HTTPS public/provider configuration, private data networks, and a loopback-only inner edge. Same-host cells passed Hybrid provider outage/no-fallback/recovery, strict private-CA TLS/proxy behavior, and restart persistence. Its Experimental maintenance workflow recovers MongoDB, Redis, ChromaDB, and uploads only into a new same-datastore-image project. This is not completed remote deployment, public certificate lifecycle, or off-host disaster recovery.

## Configuration

Core variables include `KFIVE_MODE`, `AI_PROVIDER`, `AI_DEFAULT_MODEL`, `AI_EMBEDDING_MODEL`, `MONGODB_URL`, `REDIS_URL`, `CHROMA_URL`, `OLLAMA_BASE_URL`, provider credentials, `PUBLIC_BASE_URL`, `CORS_ORIGIN`, `CODE_RUNNER_MODE`, `DOCUMENT_PROCESSOR_URL`, and `OCR_SERVICE_URL`. `PUBLIC_BASE_URL`'s origin must be present in the exact `CORS_ORIGIN` allowlist. The backend validates provider-dependent settings and rejects example JWT secrets in production. Knowledge/RAG requires an explicitly configured embedding model; it never silently uses the chat model.

The frontend defaults to same-origin `/api/v1` and `/socket.io`, so local, hybrid, and remote deployments do not need source edits. Build-time `VITE_API_URL` and `VITE_WS_URL` remain optional overrides.

## Important limitations

Ollama, OpenAI Chat Completions, Anthropic Messages, OpenAI-compatible, and custom OpenAI-compatible adapters exist, but only local Ollama is configured on the verified target. External-provider smoke tests are opt-in and have not been executed with billable credentials. KFive never silently falls back. Chat now atomically stores each bounded user turn before inference, caps context/output, uses request-scoped named SSE events, and persists safe success/failure/timeout/output-limit/cancellation metadata. A real browser verified provider timeout and explicit Stop through the Compose frontend/backend/MongoDB path, including reload persistence; successful tokens were not claimed because host Ollama still listens only on loopback and is unreachable from the backend container. Current Chat cancellation is process-local, so run one backend replica for this Experimental slice. Agent runs send one bounded prompt to the configured provider, stream the response, and persist the prompt, output, metadata, and audit timeline in MongoDB. On 2026-09-21 the production browser/local-Ollama/Mongo path passed a successful run, real UI cancellation, terminal deletion, and completed-history reload after backend restart. The browser exposes paginated history/detail and confirmed terminal-run deletion under a 500-run owner cap. Agent tools are disabled, so there is no approval workflow yet; execution coordination and retention enforcement are process-local and are not safe for multiple backend replicas. Do not place secrets in chat or agent prompts. See [docs/AGENTS.md](docs/AGENTS.md).

The Phase 10 local single-replica fixed-text critical path is Implemented while overall Workflows remain Experimental. Its only graph is server-validated `Input -> Prompt -> LLM -> Output`: provider-neutral SSE produces inert text, not executable actions. A real production browser passed local-Ollama success, durable UI cancellation, Mongo history/detail/deletion, and backend-restart persistence. Definitions and runs are owner/project scoped; archived projects are read/history-only apart from cancellation of an already-active or orphaned run as a safe-shutdown action. Input, templates, and system prompts are limited to 16 KiB, output to 256 KiB, provider timeouts use `AI_TIMEOUT_MS` (30 seconds by default), definitions to 100 and history to 500 runs per owner, pages to 50 summaries over at most ten pages, and timelines to 50 events. The backend's definition/run count-then-create checks are non-atomic across replicas, and the one-run-per-owner guard is process-local. Workflow and Agent leases are separate and do not form a shared GPU queue. Inputs, outputs, templates, system prompts, and full definition snapshots are application-readable plaintext, so do not submit secrets. See [docs/WORKFLOWS.md](docs/WORKFLOWS.md).

The Phase 11 Dataset Lab source slice is implemented and remains Experimental. It accepts authenticated owner/project-scoped CSV and flat-object JSON up to 5 MiB, 10,000 rows, 100 columns, and 16 KiB of UTF-8 data per cell; each derived input/output has a separate 10 MiB limit because serialization and formula escaping can expand the source. Deterministic local analysis covers schema/types, missing and duplicate data, numeric/category summaries, IQR outlier signals, bounded correlations, and a 50-row preview with strings truncated to 500 characters. Originals remain immutable in the persistent backend uploads volume. Cleaning creates a separate derived copy only from explicit trim, duplicate removal, missing-row removal, and CSV formula-escape choices; it never overwrites the parent and uses no Python or AI. Downloads are private attachments, archived-project records are read/download-only, and parents with derived children cannot be deleted. The 100-record owner cap and admission/rate controls are process-local/non-atomic. Uploaded values and files remain application-readable to MongoDB/filesystem/backup operators, and formula escaping does not make spreadsheets inherently safe. See [docs/DATASETS.md](docs/DATASETS.md).

The Phase 11 Model Benchmarks slice is implemented and remains Experimental. It runs the immutable provider-neutral `chat-core-v1` suite as three benign prompts repeated twice, sequentially, against the explicitly selected listed chat model. MongoDB is canonical; BullMQ carries opaque ids to a dedicated portless worker, a fenced Redis lease limits global execution, a partial unique Mongo index limits each owner, and each completed provider call is checkpointed. Reconnectable authenticated SSE uses Mongo revisions, and disconnect does not cancel durable work. The UI supports history, detail, compatible comparison, explicit cancellation, confirmed terminal deletion, and JSON export. A run is capped at six calls, 16 KiB per call, 128 KiB total, and 180 seconds. An uncertain in-flight provider call is interrupted rather than retried. On 2026-09-07, a production-Compose browser run completed all six calls through a temporary internal, CPU-only Ollama service using the installed `phi3:latest`; its 85.26-second result, metrics, timeline, export, and completed-run restart persistence were verified. Running and project-scoped cancellation, workspace/project separation, and archived-project read-only guards also passed. This does not prove the standard host-Ollama listener, container GPU access, remote-provider billing/cancellation, cross-user isolation, comparison with two successful runs, or multi-replica recovery. See [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

Code Lab's currently supported Python/JavaScript critical path has passed browser run/cancel, Redis worker, Docker runtime, Mongo history, and restart persistence; runtime images still use reviewed allowlist tags rather than immutable digests. Six structural PDF operations run locally in the browser. The opt-in isolated Document Processor provides verified PDF extraction and bounded English OCR ingestion, while native conversion and broader Document Studio capabilities remain unavailable or Planned. Knowledge/RAG accepts small TXT/Markdown sources plus completed stored PDF/PNG/JPEG text snapshots with conservative page references; see [docs/RAG.md](docs/RAG.md). Repository analysis currently accepts bounded ZIP uploads and performs deterministic read-only inspection; see [docs/REPOSITORY_ANALYZER.md](docs/REPOSITORY_ANALYZER.md). Notebook Mode now has an opt-in durable broker and locally verified two-stage execution path, but its transitive Python graph/local tags are not digest-locked and the live CachyOS proof explicitly disabled the default AppArmor requirement because that host provides seccomp without AppArmor. It remains Experimental rather than production-certified. See [docs/NOTEBOOKS.md](docs/NOTEBOOKS.md). ML experiments, training, and a general shared GPU queue remain Planned.
