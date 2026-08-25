# Agents

The Phase 9 Agent Runtime slice is **Experimental**. It provides owner-scoped agent definitions and a bounded prompt-to-model execution path with Server-Sent Events (SSE), cancellation, and a persistent MongoDB `AgentRun` audit record. It is not a tool-using autonomous-agent system.

## Current behavior

An agent stores a name, description, system prompt, requested model, temperature, optional immutable project association, and an empty tools list. Agents in archived projects remain readable but cannot be created, edited, or executed.

Starting a run snapshots the agent name, requested model, temperature, empty tool list, and a SHA-256 hash of the system prompt. The backend then sends the current system prompt and submitted user prompt to the explicitly configured AI provider and streams output to the browser. KFive does not silently select a different provider.

Each run persists:

- owner, agent, and optional project scope;
- the normalized user prompt and bounded model output;
- status, provider, actual model, usage when reported, finish reason, and fixed safe error metadata;
- queued, started, cancellation-requested, and completion timestamps; and
- a bounded lifecycle timeline containing created, started, provider-selected, cancellation, completion, or failure events.

Run-list responses return metadata only. The owner-scoped detail endpoint returns the prompt, output, and timeline. Agents with any run history cannot be deleted, because deletion would orphan retained runs; owners can explicitly delete terminal runs first to reclaim capacity. Archived-project history is read-only. If a project has already been deleted, its non-cascaded terminal runs can still be deleted so they do not permanently consume the owner's retention allowance.

## API

All routes require authentication and are mounted under `/api/v1/agents`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/:agentId/runs?page=1` | List one page of owner-scoped run summaries |
| `GET` | `/:agentId/runs/:runId` | Read one owner-scoped run with prompt, output, and timeline |
| `POST` | `/:agentId/runs` | Start an SSE run from `{ "prompt": "..." }` |
| `POST` | `/:agentId/execute` | Compatibility alias for starting the same SSE run |
| `POST` | `/:agentId/runs/:runId/cancel` | Idempotently request cancellation |
| `DELETE` | `/:agentId/runs/:runId` | Delete one terminal run; active runs and archived-project history are rejected |

The Agents page streams the active response, requests server-side cancellation before closing the request, and exposes paginated history, run metadata, prompt/output, lifecycle timeline, and confirmed terminal-run deletion. Archived projects remain history-only in the browser and the API enforces their read-only state.

## Limits and lifecycle

- Prompt input is normalized, rejects unsafe control/format characters, and is limited to 16 KiB of UTF-8.
- Persisted output is limited to 256 KiB. Crossing the limit aborts the run and records `output_limit` without appending the overflowing chunk.
- The service timeout is currently 30 seconds.
- Each owner may retain at most 500 runs across all agents. History is exposed as at most ten pages of 50 summaries, and timeline storage is bounded to 50 events per run.
- Run states are `queued`, `running`, `cancel-requested`, `succeeded`, `failed`, `cancelled`, `timed_out`, `output_limit`, or `interrupted`.

On backend startup and every 30 seconds afterwards, sufficiently stale queued/running/cancel-requested records are marked `interrupted`. This is recovery metadata, not job resumption. The count-then-create retention check is process-local and not an atomic multi-replica quota.

## Tools, approvals, and concurrency

Agent tools are deliberately disabled. The server allowlist is empty, create/update requests reject non-empty tool arrays, run snapshots always contain an empty list, and no tool definition is sent to the provider. Therefore the current runtime cannot read files, write files, execute commands, call external tools, or mutate another system on an agent's behalf.

There is no approval workflow in this slice because there are no executable tools to approve. Before any future write-capable tool is enabled, it must have an explicit server-side allowlist and schema, owner/project authorization, bounded inputs and outputs, safe retry/idempotency behavior, audit events, and an approval policy appropriate to the consequence of the action. Model text must never be treated as authorization.

Execution coordination is process-local. One active run per owner and the per-agent execution lease are held in memory, and active `AbortController` instances are not shared through MongoDB or Redis. Consequently:

- multiple backend replicas can exceed the intended per-owner concurrency limit;
- a cancellation request received by a different process cannot directly abort the provider call and is terminalized as `interrupted` when no local controller exists;
- a restart cannot resume an active run; periodic recovery eventually marks a recently updated orphan terminal after its stale threshold, but does not resume provider work; and
- a provider that ignores cancellation may continue work remotely even after KFive stops accepting its events.

Use a single backend process for this Experimental slice. Distributed leases, a durable execution queue/worker, cross-process cancellation delivery, and takeover/recovery are required before horizontal scaling.

## Privacy and pending verification

The normalized user prompt and generated output are stored in MongoDB in application-readable form so the detail API and audit record can reproduce the run. The run snapshot stores only a hash of the system prompt, but the editable Agent record separately stores the system prompt. The system prompt and user prompt are transmitted to the configured provider; when that endpoint is remote, they leave the KFive host. Terminal runs have explicit deletion and the owner cap bounds retained records, but there is no age-based retention window, bulk purge, redaction mode, or application-level field encryption. Do not submit secrets or regulated data; the configured provider, database operators, and anyone with access to backups may access submitted content.

The complete target-host path is still pending: browser to authenticated API, healthy MongoDB persistence and restart recovery, and a real configured provider including streaming, timeout, and cancellation behavior. External provider smoke tests must remain opt-in so normal verification cannot create billable requests.
