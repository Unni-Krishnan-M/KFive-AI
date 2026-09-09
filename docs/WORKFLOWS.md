# Experimental Workflows

The Phase 10 Workflow source slice is **implemented and Experimental**. It is a server-validated, fixed text pipeline:

```text
Input -> Prompt -> LLM -> Output
```

It is not a general-purpose workflow builder, automation service, or agent runtime. The server accepts only the four nodes above in that order and does not execute model output.

## Current implementation scope

- Workflow definitions are owner-scoped and may be associated with an owner-scoped project. That association is immutable after creation. The server, not a client-supplied label, validates ownership and project state.
- Definitions associated with active projects may be changed and run. Definitions and run history associated with archived projects remain readable, while definition changes, new runs, and deletion are rejected. Cancellation is the narrow safety exception: an already-active or orphaned run may still be cancelled or terminalized to stop provider work.
- A run accepts bounded text input, applies the stored prompt template, sends the resulting text through the configured provider-neutral AI interface, and streams generated text to the browser with Server-Sent Events (SSE). KFive does not silently select another provider.
- Input, output, run metadata, the full workflow-definition snapshot, and a bounded lifecycle timeline are persisted in MongoDB. The snapshot includes the prompt template and system prompt used by the run. Run lists are paginated summaries; owner-scoped detail returns the retained input, output, metadata, and timeline.
- An owner can request cancellation of an active run and explicitly delete a terminal run. Active runs and archived-project history cannot be deleted.
- A workflow definition with retained run history cannot be deleted until its terminal runs are deleted. Definitions belonging to archived projects remain read-only until the project is restored.
- Project deletion is non-cascading. If the associated project is already gone, retained terminal runs and then the run-free workflow definition remain owner-deletable so they do not permanently consume retention.
- Model output is always inert text. It is displayed and stored, never evaluated or interpreted as a command, authorization, tool call, workflow definition, or instruction to another subsystem.

The browser page, strict response contracts, authenticated API mount, persistence models, execution service, and recovery wiring exist in source. This document describes that intentionally narrow contract, not a claim that the target-host path has passed end-to-end verification.

## API

All routes require authentication and are mounted under `/api/v1/workflows`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/` | List up to 100 owner-scoped definitions, optionally filtered by `projectId` |
| `POST` | `/` | Create an owner-scoped definition in workspace or active-project scope |
| `GET` | `/:workflowId` | Read one owner-scoped definition |
| `PATCH` | `/:workflowId` | Update one definition; its project association cannot change |
| `DELETE` | `/:workflowId` | Delete a definition only after its run history is removed; archived-project definitions are rejected |
| `GET` | `/:workflowId/runs?page=1` | List one page of owner-scoped run summaries |
| `GET` | `/:workflowId/runs/:runId` | Read retained input, output, metadata, and timeline for one run |
| `POST` | `/:workflowId/runs` | Start the provider-neutral SSE text run from `{ "input": "..." }` |
| `POST` | `/:workflowId/runs/:runId/cancel` | Idempotently request cancellation, including safe shutdown of an already-active archived-project run |
| `DELETE` | `/:workflowId/runs/:runId` | Delete one terminal run; active and archived-project runs are rejected |

## Fixed graph contract

The only accepted topology is one `Input` node followed by one `Prompt` node, one `LLM` node, and one `Output` node. Connections, node kinds, ordering, positions, and configuration shapes are validated on the server. The prompt template must include the fixed `{{input}}` placeholder exactly once. The slice does not accept alternate branching, loops, arbitrary node graphs, or executable node payloads.

The following remain outside this slice:

- tools, shell commands, code runners, agents, or subprocesses;
- RAG, knowledge, document, PDF, OCR, or repository nodes;
- HTTP/webhook, filesystem, database, email, or third-party action nodes;
- branching, loops, parallel paths, schedules, triggers, retries, variables, or multi-model orchestration; and
- treating generated text as code, structured authorization, or an action request.

Adding any of those capabilities requires a separately designed and reviewed vertical slice. A provider returning tool-call-shaped or code-shaped text does not change this boundary.

## Limits and lifecycle

- Submitted input, stored prompt templates, and stored system prompts are each limited to 16 KiB of UTF-8 text.
- The template must contain `{{input}}` exactly once; after substitution, the rendered user prompt is limited to 32 KiB.
- Persisted output is limited to 256 KiB. Output beyond the bound is not retained as a successful result.
- A run has a 30-second service timeout.
- Each owner may store at most 100 workflow definitions. The backend enforces this with a count-then-create sequence rather than an atomic database quota, so concurrent requests or replicas can exceed it.
- Each owner may retain at most 500 workflow runs. The current count-then-create check is process-local and non-atomic across replicas.
- History is exposed in pages of at most 50 summaries and at most ten pages.
- Each run retains at most 50 lifecycle timeline events.
- Execution coordination permits one process-local active workflow run per owner. It is not a distributed lease.

Cancellation, concurrency, definition/run retention, and active-run ownership therefore assume a single backend process. Multiple replicas can exceed the owner definition or run limits and owner concurrency limit, and a different process cannot directly abort a provider request owned by another process. Workflow and Agent execution leases are separate process-local controls; they do not form a shared AI/GPU concurrency limit or durable GPU job queue. Startup and periodic stale-run recovery mark orphaned active records `interrupted`; they do not resume provider work. Distributed leases, atomic retention quotas, durable work dispatch, cross-process cancellation, and restart-safe resumption remain future work.

## Privacy

Workflow input, generated output, prompt templates, and system prompts are stored in application-readable plaintext so definitions can be edited and run details can be displayed. Every run snapshots the full definition, retaining another plaintext copy of the template and system prompt used for that run. The rendered prompt/input and system prompt are sent to the explicitly configured AI provider; with a remote provider, that content leaves the KFive host. Owner-scoped API authorization and terminal deletion do not provide secure erasure, application-level field encryption, redaction, or an age-based retention policy, and database operators or backup readers may still be able to access retained content.

Do not place secrets, credentials, regulated data, or other sensitive content in workflow inputs, templates, or system prompts. Restrict access to the provider, MongoDB, and backups and use appropriate storage and transport encryption for the deployment.

## Pending verification

The complete target-host path remains pending: browser definition management, authenticated owner/project authorization, active-versus-archived behavior, real configured-provider SSE streaming, MongoDB persistence and restart behavior, cancellation, timeout/output bounds, pagination/detail, and terminal deletion. External-provider smoke tests must remain opt-in so ordinary verification cannot make billable requests.

## Source verification

- 30 focused backend model/service/route tests pass.
- 7 focused frontend contract tests pass.
- The complete repository gate passes 331 tests: 59 frontend, 266 backend, and 6 Code Runner tests.
- Frontend, backend, and Code Runner lint/build targets pass.
- Default and Code Lab profile Compose configuration, lifecycle-script shell syntax, and repository diff checks pass.
