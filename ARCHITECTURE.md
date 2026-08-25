# KFive AI Architecture

## Current implemented foundation

The browser frontend is React/TypeScript/Vite. It uses same-origin REST and Socket.IO routing by default. The Node/Express/TypeScript backend owns authentication, persistence models, streaming orchestration, dependency health, and configuration validation.

```text
Browser
  ├─ /                  -> frontend static server
  ├─ /api/v1            -> Express REST/SSE
  └─ /socket.io         -> authenticated Socket.IO
                              │
                              ├─ MongoDB (users, projects, chats, agents, agent-run timelines,
                              │            workflow definitions/runs, documents, RAG sources,
                              │            repository-analysis reports)
                              ├─ Redis/BullMQ (cache, coordination, code-runs queue)
                              │       └─ trusted Code Runner broker (opt-in profile)
                              │              └─ disposable non-root runtime container
                              ├─ ChromaDB 0.4.24 (scoped knowledge chunks/vectors)
                              └─ AI provider abstraction
                                   ├─ Ollama adapter (experimental)
                                   ├─ OpenAI Chat Completions adapter (experimental)
                                   ├─ Anthropic Messages adapter (experimental)
                                   └─ OpenAI-compatible/custom adapters (experimental)
```

Runtime configuration is parsed once into a typed `EnvironmentConfig`. `KFIVE_MODE` describes deployment topology; service URLs remain environment-owned. Provider selection never silently falls back. Unsupported configured providers return explicit adapter errors.

Liveness reports only process health. Readiness separately reports MongoDB and Redis availability plus configured/unconfigured/not-checked states for AI, ChromaDB, Code Runner, Document Processor, and OCR.

## Security boundaries

- JWT HTTP and Socket.IO authentication validates algorithm, issuer, audience, and payload shape.
- User-owned chat and agent records are queried with `userId` scope.
- Agent definitions and run history are owner-scoped. Each run stores a bounded prompt/output, an immutable execution snapshot, safe status metadata, and a bounded audit timeline; paginated list responses omit prompt/output/timeline while authenticated detail responses include them. Terminal-run deletion reclaims space under the 500-run owner cap, while archived-project history stays read-only.
- Agent execution is prompt-to-provider only. The server tool allowlist is empty, non-empty tool configuration is rejected, and no tool schema is sent to a provider. There is no write-action approval subsystem because no tool actions can currently execute.
- The in-progress Phase 10 Workflow contract accepts only a server-validated `Input -> Prompt -> LLM -> Output` graph. Definitions and runs are owner/project-scoped; active projects permit mutations and execution while archived projects permit only definition/history reads, plus cancellation of an already-active or orphaned run as a safe-shutdown exception. Output from the provider-neutral SSE path is inert text and is never evaluated, dispatched as a tool call, or treated as authorization.
- Projects are owner-scoped; new project associations are revalidated server-side and deletion requires a one-use confirmation.
- Refresh tokens are stored as SHA-256 hashes rather than plaintext.
- PDF merge/extract/rotate use bounded browser-local structural processing; inputs are not uploaded and outputs are not automatically persisted.
- Knowledge source metadata is owner/project-scoped in MongoDB. Chroma collections are fingerprinted by owner/provider/model/dimension/chunking version; reads and deletes include owner/scope selectors and retrieved metadata is checked again against ready MongoDB records.
- Knowledge ingestion requires a separate embedding model, validates finite nonzero vectors and consistent dimensions, and cleans partial vectors on failure. Retrieved text is passed to generation only inside explicit untrusted-data delimiters.
- Repository ZIPs are accepted only through authenticated, rate/admission-limited memory uploads. A deterministic bounded parser inventories paths and selected `package.json` data without extraction, code execution, install hooks, filesystem writes, or network access; persisted/public reports omit archive bytes, file contents, and package-script commands.
- Native document conversion is disabled in the backend. A future native parser must live in a separate constrained Document Processor service.
- Databases are internal-only in the local Compose network.
- Containers are configured as non-root with `no-new-privileges`.
- Code Lab never executes user code in the browser or backend. Its authenticated API submits fixed-schema jobs to a separate broker. Only that trusted broker receives Docker-daemon access; runtime containers do not receive it.
- Runtime containers use a fixed language/image/command registry, non-root user, read-only root filesystem, no network/IPC/capabilities/host mounts, and fixed CPU, memory, PID, output, temporary-storage and time limits.
- Code-run completion is accepted only when its run identity, language, and runtime version match the pending persisted request. Queue replay/reconciliation and label-scoped stale cleanup bound failure recovery.

## Planned boundaries

Agent execution currently runs inside the backend request lifecycle. Its owner concurrency map, per-agent lease, abort controllers, and count-then-create retention enforcement are process-local; MongoDB stores history but is not a distributed lock, cancellation channel, or atomic quota. Periodic reconciliation terminalizes stale records but does not resume work. Multiple replicas, restart-safe execution, cross-process cancellation, atomic retention, and durable resumption require a queue/worker and distributed coordination. The target-host provider/Mongo/browser path is still pending. Future tools, especially write-capable tools, require reviewed allowlists, authorization, isolation, idempotency, audit, and approval boundaries before enablement.

Phase 10 Workflow execution has the same deliberate single-process deployment constraint while its source slice is being implemented: one active run per owner is coordinated in process, and the 100-definition and 500-run owner caps use count-then-create checks that are non-atomic across replicas. Runs are limited to 16 KiB input/templates/system prompts, 256 KiB output, 30 seconds, 50 summaries per page over at most ten pages, and 50 timeline events. Workflow and Agent execution leases are separate process-local controls and do not form a shared AI/GPU limit or durable job queue. MongoDB persistence provides history, detail, cancellation state, and terminal deletion, not a distributed lease or cancellation bus. Browser/provider/Mongo target-host E2E remains pending.

Workflow input, prompt templates, system prompts, and generated output are intentionally retained as application-readable plaintext for execution and history detail. Every run snapshots the complete definition, including the template and system prompt. A remote provider receives the rendered prompt/input and system prompt. Owner scoping, bounded retention, and terminal deletion do not provide field encryption, secure erasure, redaction, or age-based expiry.

Code Runner has an Experimental vertical slice and disabled-by-default Compose profile, but still requires target-host isolation tests and immutable runtime image digests. Docker-daemon access makes the trusted broker a high-privilege boundary; production deployments should prefer a dedicated or rootless daemon. Browser-local PDF merge/extract/rotate, bounded TXT/Markdown Knowledge/RAG, deterministic ZIP repository analysis, and the fixed Phase 10 Workflow slice are Experimental. Their live browser/provider/storage paths, a future isolated repository importer, the isolated Document Processor/OCR, general-purpose workflow capabilities, datasets, experiments, observability, Kubernetes, and remote production deployment still require independent verification or vertical slices. Project Rooms have an experimental CRUD/context slice, but export/import and the broader project-owned modules remain planned.
