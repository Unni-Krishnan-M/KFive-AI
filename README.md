# KFive AI

KFive AI is an existing browser-based, local-first AI workspace under active development. This repository is being repaired and extended incrementally; it is not yet the complete platform described in the roadmap.

## Verified baseline

As of 2026-08-26:

- Frontend production TypeScript/Vite build passes.
- Backend TypeScript build passes and emitted `@/` imports are rewritten for production execution.
- Frontend tests pass (52 tests).
- Backend tests pass (236 tests).
- Code Runner tests pass (6 Node tests).
- Frontend and backend lint commands pass.
- Docker Compose configuration validates with explicit environment input.
- Frontend and backend Docker images built successfully on the user host. Full-stack health is pending recreation of a stale MongoDB volume whose stored credentials differ from the current `.env`.
- NVIDIA GPU access is not verified; `nvidia-smi` cannot communicate with the driver in this environment.

See [STATUS.md](STATUS.md), [Project Rooms](docs/PROJECTS.md), [Experimental Workflows](docs/WORKFLOWS.md), and [docs/AUDIT_PHASE_0.md](docs/AUDIT_PHASE_0.md) for the evidence and limitations.

## Current feature states

Implemented means the code path and its local automated checks exist. Experimental means code exists but its critical external-service path has not yet been executed here. Planned means it must not be represented as working.

| Area | State | Notes |
| --- | --- | --- |
| Frontend shell, auth UI, dashboard | Experimental | Builds; browser E2E not yet executed |
| JWT auth backend and user model | Experimental | Security repairs compile; Mongo integration E2E pending |
| Chat persistence and Ollama streaming | Experimental | Streaming parser tests pass; Ollama E2E pending |
| Runtime mode/provider Settings | Experimental | Secret-safe topology, connection tests, and adapters are unit-tested; live Compose/provider E2E pending |
| Models, GPU status, smart routing | Experimental | Catalog, routing, pull/delete safety, and GPU parsing are tested; host Ollama management E2E pending |
| MongoDB/Redis configuration | Experimental | URL wiring repaired; live persistence tests pending |
| Dependency readiness reporting | Implemented | Unit-tested unavailable states; live transitions pending |
| Document storage | Experimental | Owner/project-scoped upload/list and safe failure states are tested; live persistence E2E pending |
| PDF Utilities | Experimental | Browser-local merge, extract, and rotate have validation/limit/output tests; browser download smoke pending |
| Agents | Experimental | Owner-scoped SSE runs, cancellation, paginated history/detail, terminal deletion, and bounded persistent audit timelines exist; tools are disabled and browser/provider/Mongo E2E is pending |
| Code Lab | Experimental | Real API/UI, BullMQ broker, disposable-container executor, limits, cancellation, and opt-in Compose profile are tested in source; live host-Docker isolation E2E is still mandatory |
| Project Rooms | Experimental | Owner-scoped CRUD, tags, archive/restore, activity, guarded deletion, and project context are tested; live Mongo/browser E2E pending |
| Knowledge / RAG | Experimental | Bounded TXT/Markdown ingestion, Chroma retrieval, ownership checks, and source references are tested in source; live embedding/Chroma E2E pending |
| Repository Analyzer | Experimental | Authenticated, project-aware ZIP inventory and deterministic evidence reports are source-tested; live browser/Mongo persistence and hostile-archive resource testing remain pending |
| Workflows | Experimental (implementation in progress) | Server-validated fixed Input -> Prompt -> LLM -> Output text runs with owner/project definitions and bounded persistent history; browser/provider/Mongo E2E pending |
| OCR, datasets, experiments, benchmarks | Planned | No complete vertical slice yet |
| Kubernetes, Traefik, Argo CD, observability | Planned | No verified manifests yet |
| Remote deployment | Planned | Configuration foundations exist; deployment not executed |

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

Normal shutdown preserves named volumes. `kfive-reset.sh` refuses to delete data unless `--delete-data` is supplied and an interactive confirmation is entered.

## Configuration

Core variables include `KFIVE_MODE`, `AI_PROVIDER`, `AI_DEFAULT_MODEL`, `AI_EMBEDDING_MODEL`, `MONGODB_URL`, `REDIS_URL`, `CHROMA_URL`, `OLLAMA_BASE_URL`, provider credentials, `PUBLIC_BASE_URL`, `CODE_RUNNER_MODE`, `DOCUMENT_PROCESSOR_URL`, and `OCR_SERVICE_URL`. The backend validates provider-dependent settings and rejects example JWT secrets in production. Knowledge/RAG requires an explicitly configured embedding model; it never silently uses the chat model.

The frontend defaults to same-origin `/api/v1` and `/socket.io`, so local, hybrid, and remote deployments do not need source edits. Build-time `VITE_API_URL` and `VITE_WS_URL` remain optional overrides.

## Important limitations

Ollama, OpenAI Chat Completions, Anthropic Messages, OpenAI-compatible, and custom OpenAI-compatible adapters exist, but only local Ollama is configured on the verified target. External-provider smoke tests are opt-in and have not been executed with billable credentials. KFive never silently falls back. Agent runs currently send one bounded prompt to the configured provider, stream the response, and persist the prompt, output, metadata, and audit timeline in MongoDB. The browser exposes paginated history/detail and confirmed terminal-run deletion under a 500-run owner cap. Agent tools are disabled, so there is no approval workflow yet; execution coordination and retention enforcement are process-local and are not safe for multiple backend replicas. Do not place secrets in agent prompts. See [docs/AGENTS.md](docs/AGENTS.md).

The Phase 10 Workflow slice is Experimental and still being implemented. Its only graph is server-validated `Input -> Prompt -> LLM -> Output`: provider-neutral SSE produces inert text, not executable actions. Definitions and runs are owner/project scoped; archived projects are read/history-only apart from cancellation of an already-active or orphaned run as a safe-shutdown action. Input, templates, and system prompts are limited to 16 KiB, output to 256 KiB, runs to 30 seconds, definitions to 100 and history to 500 runs per owner, pages to 50 summaries over at most ten pages, and timelines to 50 events. The backend's definition/run count-then-create checks are non-atomic across replicas, and the one-run-per-owner guard is process-local. Workflow and Agent leases are separate and do not form a shared GPU queue. Inputs, outputs, templates, system prompts, and full definition snapshots are application-readable plaintext, so do not submit secrets. See [docs/WORKFLOWS.md](docs/WORKFLOWS.md).

Code Lab is opt-in and remains Experimental until its real Docker isolation suite passes on the target host. Runtime images currently use reviewed allowlist tags rather than immutable digests. PDF merge/extract/rotate run locally in the browser; server-side conversion returns an explicit unavailable error until a separate isolated Document Processor exists. Knowledge/RAG currently accepts small TXT/Markdown sources only; see [docs/RAG.md](docs/RAG.md). Repository analysis currently accepts bounded ZIP uploads and performs deterministic read-only inspection; see [docs/REPOSITORY_ANALYZER.md](docs/REPOSITORY_ANALYZER.md).
