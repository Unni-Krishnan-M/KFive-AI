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
                              │            repository-analysis reports, dataset metadata/analysis,
                              │            bounded notebook documents and durable notebook runs)
                              ├─ Redis/BullMQ (cache, coordination, code-runs and notebook-runs queues)
                              │       └─ trusted Code Runner broker (opt-in profile)
                              │              └─ disposable non-root runtime container
                              │       └─ trusted Notebook broker (opt-in profile)
                              │              ├─ disposable UID-10001 Python runtime
                              │              └─ after runtime removal: UID-10002 verifier
                              ├─ ChromaDB 0.4.24 (scoped knowledge chunks/vectors)
                              ├─ persistent backend uploads (private document and immutable dataset files)
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
- Chat uses an embedded MongoDB generation lease keyed by request id. Beginning a turn atomically appends the bounded user message and marks the generation running before provider work; a status/request-id compare-and-swap appends one terminal assistant message and records safe status, provider/model, usage, TTFT, latency, and output bytes. Named SSE mirrors this durable lifecycle, while startup/periodic recovery marks expired leases interrupted. Conversation lists project summary fields and omit message arrays.
- Agent definitions and run history are owner-scoped. Each run stores a bounded prompt/output, an immutable execution snapshot, safe status metadata, and a bounded audit timeline; paginated list responses omit prompt/output/timeline while authenticated detail responses include them. Terminal-run deletion reclaims space under the 500-run owner cap, while archived-project history stays read-only.
- Agent execution is prompt-to-provider only. The server tool allowlist is empty, non-empty tool configuration is rejected, and no tool schema is sent to a provider. There is no write-action approval subsystem because no tool actions can currently execute.
- The Phase 10 Workflow source contract accepts only a server-validated `Input -> Prompt -> LLM -> Output` graph. Definitions and runs are owner/project-scoped; active projects permit mutations and execution while archived projects permit only definition/history reads, plus cancellation of an already-active or orphaned run as a safe-shutdown exception. Output from the provider-neutral SSE path is inert text and is never evaluated, dispatched as a tool call, or treated as authorization.
- Projects are owner-scoped; new project associations are revalidated server-side and deletion requires a one-use confirmation.
- Refresh tokens are stored as SHA-256 hashes rather than plaintext.
- PDF merge/extract/rotate use bounded browser-local structural processing; inputs are not uploaded and outputs are not automatically persisted.
- Knowledge source metadata is owner/project-scoped in MongoDB. Chroma collections are fingerprinted by owner/provider/model/dimension/chunking version; reads and deletes include owner/scope selectors and retrieved metadata is checked again against ready MongoDB records.
- Knowledge ingestion requires a separate embedding model, validates finite nonzero vectors and consistent dimensions, and cleans partial vectors on failure. Retrieved text is passed to generation only inside explicit untrusted-data delimiters.
- Repository ZIPs are accepted only through authenticated, rate/admission-limited memory uploads. A deterministic bounded parser inventories paths and selected `package.json` data without extraction, code execution, install hooks, filesystem writes, or network access; persisted/public reports omit archive bytes, file contents, and package-script commands.
- Dataset Lab accepts authenticated owner/project CSV and flat-object JSON under 5 MiB/10,000-row/100-column/16-KiB UTF-8-cell bounds. The Node backend performs deterministic schema, quality, numeric, category, IQR, and correlation analysis with a 50-row/500-character preview; it invokes neither Python nor AI. MongoDB retains owner/project metadata, bounded analysis/preview, checksums, and derivation relationships, while immutable originals and explicit non-overwriting derived copies remain in private persistent backend uploads. Downloads re-check ownership and use attachment responses without exposing storage paths.
- Notebook documents and runs are authenticated and owner/project scoped. Full saves use optimistic revisions; project association is immutable; archived projects are read-only; inputs, history, artifacts, and outputs are bounded. The API enqueues only an opaque run id. A dedicated portless broker alone receives Docker-daemon access; user code runs without network, host mounts, capabilities, privilege, or the Docker socket. The broker removes the disposable runtime before a distinct no-user-code verifier reconstructs accepted inert output.
- Native document conversion is disabled in the backend. A future native parser must live in a separate constrained Document Processor service.
- Databases are internal-only in the local Compose network.
- Containers are configured as non-root with `no-new-privileges`.
- Code Lab never executes user code in the browser or backend. Its authenticated API submits fixed-schema jobs to a separate broker. Only that trusted broker receives Docker-daemon access; runtime containers do not receive it.
- Runtime containers use a fixed language/image/command registry, non-root user, read-only root filesystem, no network/IPC/capabilities/host mounts, and fixed CPU, memory, PID, output, temporary-storage and time limits.
- Code-run completion is accepted only when its run identity, language, and runtime version match the pending persisted request. Queue replay/reconciliation and label-scoped stale cleanup bound failure recovery.

## Planned boundaries

Chat generation executes inside the backend request lifecycle. Its live abort-controller registry and explicit Stop channel are process-local; MongoDB prevents two running generations in one conversation and records recovery deadlines, but it is not a cross-replica cancellation bus. Run one backend replica for this Experimental path until execution moves to a durable worker or gains a distributed lease/cancellation channel. A browser disconnect or Stop is durable once the owning process terminalizes the request; a process crash is recorded later as interrupted rather than resumed. Successful host-Ollama tokens remain unverified until the container can reach the deliberately configured host listener.

Agent execution currently runs inside the backend request lifecycle. Its owner concurrency map, per-agent lease, abort controllers, and count-then-create retention enforcement are process-local; MongoDB stores history but is not a distributed lock, cancellation channel, or atomic quota. Periodic reconciliation terminalizes stale records but does not resume work. Multiple replicas, restart-safe execution, cross-process cancellation, atomic retention, and durable resumption require a queue/worker and distributed coordination. The target-host provider/Mongo/browser path is still pending. Future tools, especially write-capable tools, require reviewed allowlists, authorization, isolation, idempotency, audit, and approval boundaries before enablement.

Phase 10 Workflow execution has a deliberate single-process deployment constraint: one active run per owner is coordinated in process, and the 100-definition and 500-run owner caps use count-then-create checks that are non-atomic across replicas. Runs are limited to 16 KiB input/templates/system prompts, 256 KiB output, 30 seconds, 50 summaries per page over at most ten pages, and 50 timeline events. Workflow and Agent execution leases are separate process-local controls and do not form a shared AI/GPU limit or durable job queue. MongoDB persistence provides history, detail, cancellation state, and terminal deletion, not a distributed lease or cancellation bus. Browser/provider/Mongo target-host E2E remains pending.

Phase 11 Model Benchmarks uses the shared provider abstraction and an immutable `chat-core-v1` definition: three fixed prompts repeated twice, executed sequentially against an explicitly selected listed chat model. MongoDB holds canonical owner/project state; BullMQ transports only an opaque id to a dedicated worker; a renewable Redis lease uses a monotonic fence and unique owner; and Mongo revision/fence/owner compare-and-swap protects checkpoints and terminal state. SSE revisions are reconnectable, queued cancellation does not require a worker, and uncertain in-flight calls are interrupted rather than retried. The global execution lease and per-owner partial unique index are distributed controls, while project mutation coordination and retention counting are still non-atomic across API replicas. Benchmark history is not yet a Smart Router input. This benchmark-specific queue is separate from the implemented opt-in Notebook broker, any future training broker, and the still-planned general shared GPU scheduler.

Workflow input, prompt templates, system prompts, and generated output are intentionally retained as application-readable plaintext for execution and history detail. Every run snapshots the complete definition, including the template and system prompt. A remote provider receives the rendered prompt/input and system prompt. Owner scoping, bounded retention, and terminal deletion do not provide field encryption, secure erasure, redaction, or age-based expiry.

Dataset parsing, owner quotas, admission, and rate controls currently run inside one backend process. The 100-record owner quota is a non-atomic count-then-create check, and process-local admission/rate state does not coordinate replicas. Original and derived bytes live outside MongoDB in the persistent uploads volume, so metadata/file publication and deletion are not one transactional operation and require target-host failure/cleanup verification. Archived-project datasets are read/download-only; source parents cannot be deleted while derived children remain. Dataset values retained in previews/categories and private files remain application-readable and may persist in backups. CSV formula escaping is an explicit derived-copy transformation, not a claim that the original or resulting spreadsheet is safe.

Code Runner has an Experimental vertical slice and disabled-by-default Compose profile, but still requires target-host isolation tests and immutable runtime image digests. Docker-daemon access makes either trusted broker a high-privilege boundary; production deployments should prefer a dedicated or rootless daemon. Browser-local PDF merge/extract/rotate, bounded TXT/Markdown Knowledge/RAG, deterministic ZIP repository analysis, the fixed Phase 10 Workflow slice, and the bounded Phase 11 Dataset Lab, Model Benchmarks, and Notebook Mode slices are Experimental. Notebook execution has passed its local functional/container lifecycle path, but production AppArmor-host, immutable-image, remote/Kubernetes, multi-worker fencing, and broader ownership/browser proofs remain. Other live browser/provider/storage paths, the isolated Document Processor/OCR, general-purpose workflow capabilities, ML experiments/training, a general shared GPU queue, observability, Kubernetes, and remote production deployment still require independent verification or vertical slices. Project Rooms have an experimental CRUD/context slice, but export/import and broader project-owned modules remain planned.

Notebook execution uses MongoDB as canonical state, BullMQ attempts-one opaque-id jobs, one atomic active-owner slot, and an expiring Redis global worker lease/health record. The broker streams hash-checked data through constrained containers instead of host mounts or Docker copy, force-removes the UID-10001 runtime, records the lifecycle transition, then starts the distinct UID-10002 verifier. The verifier executes no notebook code and recreates only bounded canonical inert output. Cancellation is signaled through Redis and also polled from Mongo; heartbeat/lease loss aborts and interrupts the run. A real canary must pass before availability is published. The current design intentionally supports one notebook worker: Redis and Mongo do not yet share a transactional fencing epoch for safe horizontal workers.
